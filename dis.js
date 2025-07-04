require("dotenv").config();
const { Client, GatewayIntentBits, PermissionsBitField } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const fs = require("fs");
const path = require("path");
const { QuickDB } = require("quick.db");
const db = new QuickDB();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const voiceJoinMap = new Map();
const spamMap = new Map();
const SPAM_LIMIT = 5;
const SPAM_TIME = 10 * 1000;
const TIMEOUT_DURATION = 60 * 1000;

client.commands = new Map();
const commandFiles = fs
  .readdirSync(path.join(__dirname, "commands"))
  .filter((file) => file.endsWith(".js"));
for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.name, command);
}

async function getJoinSound() {
  return (await db.get("joinSound")) || "join.mp3";
}
async function getLeaveSound() {
  return (await db.get("leaveSound")) || "leave.mp3";
}

async function playSound(channel, type) {
  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
  } catch (err) {
    console.error(`❌ Failed to join VC '${channel.name}': ${err.message}`);
    return;
  }

  const player = createAudioPlayer();
  let fileName = type === "join" ? await getJoinSound() : await getLeaveSound();
  const fullPath = path.join(__dirname, "sounds", fileName);
  if (!fs.existsSync(fullPath)) {
    console.warn(`⚠️ Sound file '${fileName}' does not exist! Using default.`);
    fileName = type === "join" ? "join.mp3" : "leave.mp3";
  }

  const resource = createAudioResource(path.join(__dirname, "sounds", fileName));
  try {
    connection.subscribe(player);
    player.play(resource);
  } catch (err) {
    console.error("❌ Failed to play audio:", err);
    connection.destroy();
    return;
  }

  const timeout = setTimeout(() => connection.destroy(), 15000);

  player.on(AudioPlayerStatus.Idle, () => {
    connection.destroy();
    clearTimeout(timeout);
  });

  connection.on("stateChange", (_, newState) => {
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      connection.destroy();
      clearTimeout(timeout);
    }
  });
}

async function addVoiceTime(userId, guildId, seconds, day) {
  const dateKey = day || new Date().toISOString().split("T")[0];
  const key = `voiceTime_${guildId}_${userId}_${dateKey}`;
  const current = (await db.get(key)) || 0;
  await db.set(key, current + seconds);
}

client.on("voiceStateUpdate", async (oldState, newState) => {
  const userId = newState.id;
  const guildId = newState.guild.id;
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;
  const now = Date.now();

  const key = `${guildId}_${userId}`;

  if (!oldChannel && newChannel) {
    voiceJoinMap.set(key, now);
  } else if (oldChannel && !newChannel) {
    if (voiceJoinMap.has(key)) {
      const joinTime = voiceJoinMap.get(key);
      await addVoiceTime(userId, guildId, Math.floor((now - joinTime) / 1000));
      voiceJoinMap.delete(key);
    }
  } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
    if (voiceJoinMap.has(key)) {
      const joinTime = voiceJoinMap.get(key);
      await addVoiceTime(userId, guildId, Math.floor((now - joinTime) / 1000));
    }
    voiceJoinMap.set(key, now);
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const userId = message.author.id;
  const content = message.content.trim();
  const now = Date.now();

  let userData = spamMap.get(userId) || [];
  userData = userData.filter((m) => now - m.timestamp < SPAM_TIME);
  userData.push({ content, id: message.id, timestamp: now });
  spamMap.set(userId, userData);

  const sameMessages = userData.filter((m) => m.content === content);
  if (sameMessages.length >= SPAM_LIMIT - 1) {
    try {
      for (const msgInfo of sameMessages) {
        const msgToDelete = await message.channel.messages.fetch(msgInfo.id).catch(() => null);
        if (msgToDelete) await msgToDelete.delete().catch(() => null);
      }

      await message.channel.send(`<@${userId}>, stop spamming. You are being timed out.`);

      const member = await message.guild.members.fetch(userId);
      const botMember = message.guild.members.me;
      if (botMember.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        await member.timeout(TIMEOUT_DURATION, "Repeated message spam");
        console.log(`✅ Timed out: ${member.user.tag}`);
      } else {
        console.warn("⚠️ Missing 'ModerateMembers' permission.");
      }
    } catch (err) {
      console.error("❌ Timeout failed:", err);
    }
    spamMap.delete(userId);
  }
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  setInterval(async () => {
    const now = Date.now();
    const today = new Date().toISOString().split("T")[0];

    for (const [key, joinTime] of voiceJoinMap.entries()) {
      const [guildId, userId] = key.split("_");
      await addVoiceTime(userId, guildId, Math.floor((now - joinTime) / 1000));
      voiceJoinMap.set(key, now);
    }

    const allData = await db.all();
    const guildIds = new Set();
    for (const item of allData) {
      if (item.id.startsWith("voiceLogChannelId_")) {
        guildIds.add(item.id.replace("voiceLogChannelId_", ""));
      }
    }

    for (const guildId of guildIds) {
      const filtered = allData.filter(
        (item) => item.id.startsWith(`voiceTime_${guildId}_`) && item.id.endsWith(`_${today}`)
      );
      if (!filtered.length) continue;

      const lines = filtered.map(({ id, value }) => {
        const userId = id.split("_")[2];
        const h = Math.floor(value / 3600);
        const m = Math.floor((value % 3600) / 60);
        const s = value % 60;
        return `<@${userId}> — **${h}h ${m}m ${s}s**`;
      });

      try {
        const channelId = await db.get(`voiceLogChannelId_${guildId}`);
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
          channel.send(`⏱️ **[Auto Report] Voice Time So Far Today**:\n\n${lines.join("\n")}`);
        }
      } catch (err) {
        console.error(`❌ Failed to send auto report in guild ${guildId}:`, err);
      }
    }
  }, 30 * 60 * 1000);
});

client.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!") || message.author.bot) return;
  const args = message.content.slice(1).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();
  const command = client.commands.get(commandName);
  if (!command) return;

  try {
    await command.execute(message, args, db, voiceJoinMap);
  } catch (err) {
    console.error(err);
    message.reply("❌ Error executing command.");
  }
});

client.login(process.env.DISCORD_TOKEN);
