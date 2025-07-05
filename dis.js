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

const OWNER_ID = process.env.OWNER_ID;
const voiceJoinMap = new Map();
const spamMap = new Map();
const recentMessages = new Set();
const SPAM_LIMIT = 5;
const SPAM_TIME = 10 * 1000;
const TIMEOUT_DURATION = 60 * 1000;

// Load commands
client.commands = new Map();
const commandFiles = fs
  .readdirSync(path.join(__dirname, "commands"))
  .filter((file) => file.endsWith(".js"));
for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.name, command);
}

// 🔊 Play join/leave sound for owner only
function playSound(channel, fileName) {
  const filePath = path.join(__dirname, "sounds", fileName);
  if (!fs.existsSync(filePath)) return;

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
  });

  const player = createAudioPlayer();
  const resource = createAudioResource(filePath);
  connection.subscribe(player);
  player.play(resource);

  const timeout = setTimeout(() => {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
  }, 15000);

  player.on(AudioPlayerStatus.Idle, () => {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
      clearTimeout(timeout);
    }
  });
}

// 🔁 Weekly cleanup (for snipes)
async function weeklyCleanup() {
  const allKeys = await db.all();
  const now = Date.now();
  for (const item of allKeys) {
    if (item.id.startsWith("snipe_")) {
      const data = item.value;
      const oneWeekOld = data.filter((entry) => now - entry.timestamp < 7 * 24 * 60 * 60 * 1000);
      await db.set(item.id, oneWeekOld);
    }
  }
}
setInterval(weeklyCleanup, 7 * 24 * 60 * 60 * 1000); // once a week

// 📞 Voice State Tracking
client.on("voiceStateUpdate", async (oldState, newState) => {
  const userId = newState.id;
  const guildId = newState.guild.id;
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;
  const now = Date.now();
  const key = `${guildId}_${userId}`;

  // 🔊 Owner SFX
  if (userId === OWNER_ID) {
    if (!oldChannel && newChannel) playSound(newChannel, "join.mp3");
    else if (oldChannel && !newChannel) playSound(oldChannel, "leave.mp3");
    else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) playSound(newChannel, "join.mp3");
  }

  // ⏱️ Voice time tracking
  if (!oldChannel && newChannel) {
    voiceJoinMap.set(key, now);
  } else if (oldChannel && !newChannel) {
    if (voiceJoinMap.has(key)) {
      const joinTime = voiceJoinMap.get(key);
      const timeSpent = Math.floor((now - joinTime) / 1000);
      const dateKey = new Date().toISOString().split("T")[0];
      const dbKey = `voiceTime_${guildId}_${userId}_${dateKey}`;
      await db.set(dbKey, ((await db.get(dbKey)) || 0) + timeSpent);
      voiceJoinMap.delete(key);
    }
  } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
    if (voiceJoinMap.has(key)) {
      const joinTime = voiceJoinMap.get(key);
      const timeSpent = Math.floor((now - joinTime) / 1000);
      const dateKey = new Date().toISOString().split("T")[0];
      const dbKey = `voiceTime_${guildId}_${userId}_${dateKey}`;
      await db.set(dbKey, ((await db.get(dbKey)) || 0) + timeSpent);
    }
    voiceJoinMap.set(key, now);
  }
});

// 💬 Message Deletion Logging
client.on("messageDelete", async (message) => {
  if (!message.guild || !message.author || message.author.bot) return;
  const guildId = message.guild.id;
  const log = (await db.get(`snipe_${guildId}`)) || [];
  log.unshift({
    content: message.content,
    author: message.author.tag,
    authorId: message.author.id,
    timestamp: Date.now(),
  });
  if (log.length > 20) log.pop();
  await db.set(`snipe_${guildId}`, log);
});

// 💬 Message Handling
client.on("messageCreate", async (message) => {
  if (recentMessages.has(message.id)) return;
  recentMessages.add(message.id);
  setTimeout(() => recentMessages.delete(message.id), 5000);

  if (message.author.bot || !message.guild) return;

  const userId = message.author.id;
  const content = message.content.trim();
  const now = Date.now();

  // Spam filter
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
      }
    } catch (err) {
      console.error("❌ Timeout failed:", err);
    }
    spamMap.delete(userId);
    return;
  }

  // Command handler
  if (!message.content.startsWith("!")) return;
  const args = message.content.slice(1).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();
  const command = client.commands.get(commandName);
  if (!command) return;

  try {
    await command.execute(message, args, db, voiceJoinMap, client);
  } catch (err) {
    console.error(err);
    message.reply("❌ Error executing command.");
  }
});

// ⏱️ Auto Voice Report
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  setInterval(async () => {
    const now = Date.now();
    const today = new Date().toISOString().split("T")[0];

    for (const [key, joinTime] of voiceJoinMap.entries()) {
      const [guildId, userId] = key.split("_");
      const dbKey = `voiceTime_${guildId}_${userId}_${today}`;
      await db.set(dbKey, ((await db.get(dbKey)) || 0) + Math.floor((now - joinTime) / 1000));
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

client.login(process.env.DISCORD_TOKEN);
