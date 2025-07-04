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
const SPAM_TIME = 10 * 1000; // 10 seconds
const TIMEOUT_DURATION = 60 * 1000; // 60 seconds timeout

client.commands = new Map();
const commandFiles = fs
  .readdirSync(path.join(__dirname, "commands"))
  .filter((file) => file.endsWith(".js"));
for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.name, command);
}

// Returns the join sound filename or default
async function getJoinSound() {
  return (await db.get("joinSound")) || "join.mp3";
}
// Returns the leave sound filename or default
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

  const timeout = setTimeout(() => {
    connection.destroy();
  }, 15000);

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

// Add seconds to user voice time on given day (defaults to today)
async function addVoiceTime(userId, guildId, seconds, day) {
  const dateKey = day || new Date().toISOString().split("T")[0];
  const key = `voiceTime_${guildId}_${userId}_${dateKey}`;
  const current = (await db.get(key)) || 0;
  await db.set(key, current + seconds);
}

function getPreviousDayDateString() {
  const today = new Date();
  today.setDate(today.getDate() - 1);
  return today.toISOString().split("T")[0];
}

client.on("voiceStateUpdate", async (oldState, newState) => {
  const userId = newState.id;
  const guildId = newState.guild.id;
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;
  const now = Date.now();

  if (!oldChannel && newChannel) {
    // User joined a voice channel
    voiceJoinMap.set(`${guildId}_${userId}`, now);
  } else if (oldChannel && !newChannel) {
    // User left voice channel
    const key = `${guildId}_${userId}`;
    if (voiceJoinMap.has(key)) {
      const joinTime = voiceJoinMap.get(key);
      const timeSpent = Math.floor((now - joinTime) / 1000);
      await addVoiceTime(userId, guildId, timeSpent);
      voiceJoinMap.delete(key);
    }
  } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
    // User switched voice channel
    const key = `${guildId}_${userId}`;
    if (voiceJoinMap.has(key)) {
      const joinTime = voiceJoinMap.get(key);
      const timeSpent = Math.floor((now - joinTime) / 1000);
      await addVoiceTime(userId, guildId, timeSpent);
    }
    voiceJoinMap.set(`${guildId}_${userId}`, now);
  }
});

// Command to get or set voice log channel or get voice time report
client.on("messageCreate", async (msg) => {
  if (!msg.content.toLowerCase().startsWith("!voicetime")) return;

  const args = msg.content.trim().split(/\s+/).slice(1);
  const guildId = msg.guild.id;

  // Handle: !voicetime channel <channelId> => set voice log channel for guild
  if (args[0] === "channel") {
    // Permission check: user role position must be higher than bot's
    const botMember = msg.guild.members.me;
    const member = msg.member;

    if (member.roles.highest.position <= botMember.roles.highest.position) {
      return msg.channel.send("❌ You must have a higher role than the bot to set the voice log channel.");
    }

    const channelId = args[1];
    if (!channelId) return msg.channel.send("❌ Please provide a channel ID.");

    const channel = msg.guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) {
      return msg.channel.send("❌ Invalid channel ID or not a text channel.");
    }

    await db.set(`voiceLogChannelId_${guildId}`, channelId);
    return msg.channel.send(`✅ Voice log channel set to <#${channelId}>.`);
  }

  // Else, treat as date for report: !voicetime [date]
  let dateArg = args[0]?.toLowerCase();
  let day =
    dateArg === "yesterday"
      ? getPreviousDayDateString()
      : !dateArg || dateArg === "today"
      ? new Date().toISOString().split("T")[0]
      : /^\d{4}-\d{2}-\d{2}$/.test(dateArg)
      ? dateArg
      : null;

  if (!day) return msg.channel.send("❌ Invalid date format.");

  // Save current voice time for all users in voice channels before reporting
  const now = Date.now();
  for (const [key, joinTime] of voiceJoinMap.entries()) {
    if (!key.startsWith(guildId)) continue; // only for this guild
    const timeSpent = Math.floor((now - joinTime) / 1000);
    const [, userId] = key.split("_");
    await addVoiceTime(userId, guildId, timeSpent);
    voiceJoinMap.set(key, now);
  }

  // Fetch all voice time data for this guild and day
  const allData = await db.all();
  const filtered = allData.filter(
    (item) => item.id.startsWith(`voiceTime_${guildId}_`) && item.id.endsWith(`_${day}`)
  );

  if (!filtered.length) return msg.channel.send(`📭 No voice activity for **${day}**.`);

  const lines = filtered.map(({ id, value }) => {
    // id format: voiceTime_<guildId>_<userId>_<date>
    const parts = id.split("_");
    const userId = parts[2];
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    const s = value % 60;
    return `<@${userId}> — **${h}h ${m}m ${s}s**`;
  });

  msg.channel.send(`📊 **Voice Time for ${day}**:\n\n${lines.join("\n")}`);
});

// Spam protection & timeout on repeated identical messages
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
      const canModerate = botMember.permissions.has(PermissionsBitField.Flags.ModerateMembers);

      if (canModerate) {
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

// Auto-update voice time and send report every 30 minutes per guild
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  setInterval(async () => {
    const now = Date.now();
    const today = new Date().toISOString().split("T")[0];

    for (const [key, joinTime] of voiceJoinMap.entries()) {
      const [guildId, userId] = key.split("_");
      const timeSpent = Math.floor((now - joinTime) / 1000);
      await addVoiceTime(userId, guildId, timeSpent);
      voiceJoinMap.set(key, now);
    }

    // Get all guild IDs where voice log channel is set
    const allData = await db.all();
    const guildIds = new Set();
    for (const item of allData) {
      if (item.id.startsWith("voiceLogChannelId_")) {
        guildIds.add(item.id.replace("voiceLogChannelId_", ""));
      }
    }

    // For each guild, send the report to the saved channel
    for (const guildId of guildIds) {
      const filtered = allData.filter(
        (item) => item.id.startsWith(`voiceTime_${guildId}_`) && item.id.endsWith(`_${today}`)
      );

      if (!filtered.length) continue;

      const lines = filtered.map(({ id, value }) => {
        const parts = id.split("_");
        const userId = parts[2];
        const h = Math.floor(value / 3600);
        const m = Math.floor((value % 3600) / 60);
        const s = value % 60;
        return `<@${userId}> — **${h}h ${m}m ${s}s**`;
      });

      try {
        const channelId = (await db.get(`voiceLogChannelId_${guildId}`));
        if (!channelId) continue;
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) continue;

        channel.send(`⏱️ **[Auto Report] Voice Time So Far Today**:\n\n${lines.join("\n")}`);
      } catch (err) {
        console.error(`❌ Failed to send auto report in guild ${guildId}:`, err);
      }
    }
  }, 30 * 60 * 1000); // 30 minutes interval
});

// Pass other commands to your commands folder
client.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!") || message.author.bot) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();
  const command = client.commands.get(commandName);
  if (!command) return;

  try {
    await command.execute(message, args, db);
  } catch (err) {
    console.error(err);
    message.reply("❌ Error executing command.");
  }
});

client.login(process.env.DISCORD_TOKEN);
