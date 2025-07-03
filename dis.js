require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
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

const YOUR_USER_ID = process.env.OWNER_ID;
const VOICE_LOG_CHANNEL_ID = process.env.VOICE_LOG_CHANNEL_ID;

const voiceJoinMap = new Map(); // Tracks users currently in voice + join timestamp

// 🔊 Play join/leave sound for owner only
function playSound(channel, fileName) {
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
  const resource = createAudioResource(path.join(__dirname, "sounds", fileName));

  try {
    connection.subscribe(player);
    player.play(resource);
  } catch (err) {
    console.error("❌ Failed to play audio:", err);
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
    return;
  }

  const timeout = setTimeout(() => {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
      console.log("⏱️ Timeout: Forced disconnect.");
    }
  }, 15000);

  player.on(AudioPlayerStatus.Idle, () => {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
      clearTimeout(timeout);
    }
  });

  connection.on("stateChange", (oldState, newState) => {
    if (
      oldState.status !== VoiceConnectionStatus.Destroyed &&
      newState.status === VoiceConnectionStatus.Disconnected
    ) {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
        clearTimeout(timeout);
        console.log("⚠️ Bot manually disconnected.");
      }
    }
  });
}

// ⌛ Store time in DB (seconds added for user on day)
async function addVoiceTime(userId, seconds, day) {
  const dateKey = day || new Date().toISOString().split("T")[0];
  const key = `voiceTime_${userId}_${dateKey}`;
  const current = (await db.get(key)) || 0;
  await db.set(key, current + seconds);
}

// Get voice time for a user for a specific day
async function getVoiceTime(userId, day) {
  const dateKey = day || new Date().toISOString().split("T")[0];
  const key = `voiceTime_${userId}_${dateKey}`;
  return (await db.get(key)) || 0;
}

// Get previous day string "YYYY-MM-DD"
function getPreviousDayDateString() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return yesterday.toISOString().slice(0, 10);
}

// 🎧 Track join/leave/move of all users except the owner (owner handled separately for sounds)
client.on("voiceStateUpdate", async (oldState, newState) => {
  const userId = newState.id;
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;
  const now = Date.now();

  // Play sounds only for OWNER_ID
  if (userId === YOUR_USER_ID) {
    if (!oldChannel && newChannel) {
      console.log(`🔊 Joined VC: ${newChannel.name}`);
      playSound(newChannel, "join.mp3");
    } else if (oldChannel && !newChannel) {
      console.log(`🔕 Left VC: ${oldChannel.name}`);
      playSound(oldChannel, "leave.mp3");
    } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
      console.log(`🔁 Moved from VC '${oldChannel.name}' to '${newChannel.name}'`);
      playSound(newChannel, "join.mp3");
    }
    return;
  }

  if (!oldChannel && newChannel) {
    // User joined VC
    voiceJoinMap.set(userId, now);
  } else if (oldChannel && !newChannel) {
    // User left VC
    if (voiceJoinMap.has(userId)) {
      const joinTime = voiceJoinMap.get(userId);
      const timeSpent = Math.floor((now - joinTime) / 1000);
      await addVoiceTime(userId, timeSpent);
      voiceJoinMap.delete(userId);
    }
  } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
    // User moved VC
    if (voiceJoinMap.has(userId)) {
      const joinTime = voiceJoinMap.get(userId);
      const timeSpent = Math.floor((now - joinTime) / 1000);
      await addVoiceTime(userId, timeSpent);
    }
    voiceJoinMap.set(userId, now);
  }
});

// 📊 Command: !voicetime [optional: date or "yesterday"]
client.on("messageCreate", async (msg) => {
  if (!msg.content.toLowerCase().startsWith("!voicetime")) return;

  let parts = msg.content.trim().split(/\s+/);
  let dateArg = null;
  if (parts.length > 1) {
    dateArg = parts[1].toLowerCase();
  }

  let day;
  if (!dateArg || dateArg === "today") {
    day = new Date().toISOString().split("T")[0];
  } else if (dateArg === "yesterday") {
    day = getPreviousDayDateString();
  } else {
    // Validate date format YYYY-MM-DD roughly
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
      day = dateArg;
    } else {
      msg.channel.send("❌ Invalid date format. Use YYYY-MM-DD or 'yesterday'.");
      return;
    }
  }

  // Before showing results, update voice time for all users currently connected in voice channels:
  const now = Date.now();
  for (const [userId, joinTime] of voiceJoinMap.entries()) {
    const timeSpent = Math.floor((now - joinTime) / 1000);
    await addVoiceTime(userId, timeSpent);
    voiceJoinMap.set(userId, now);
  }

  // Fetch all stored voice times for that day
  const allData = await db.all();
  const filtered = allData.filter((item) => item.id.endsWith(`_${day}`));
  if (filtered.length === 0) {
    msg.channel.send(`📭 No voice activity recorded for **${day}**.`);
    return;
  }

  // Format result message
  const lines = filtered.map((item) => {
    const userId = item.id.split("_")[1];
    const timeSec = item.value;
    const h = Math.floor(timeSec / 3600);
    const m = Math.floor((timeSec % 3600) / 60);
    const s = timeSec % 60;
    return `<@${userId}> — **${h}h ${m}m ${s}s**`;
  });

  const finalMessage = `📊 **Voice Time for ${day}**:\n\n${lines.join("\n")}`;
  msg.channel.send(finalMessage);
});

// 🔄 Auto-update and report every 30 minutes to the VOICE_LOG_CHANNEL_ID
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  setInterval(async () => {
    const now = Date.now();
    const today = new Date().toISOString().split("T")[0];

    // Update voice time for currently connected users
    for (const [userId, joinTime] of voiceJoinMap.entries()) {
      const timeSpent = Math.floor((now - joinTime) / 1000);
      await addVoiceTime(userId, timeSpent);
      voiceJoinMap.set(userId, now);
    }

    // Prepare report message
    const allData = await db.all();
    const filtered = allData.filter((item) => item.id.endsWith(`_${today}`));
    if (filtered.length === 0) return;

    const lines = filtered.map((item) => {
      const userId = item.id.split("_")[1];
      const timeSec = item.value;
      const h = Math.floor(timeSec / 3600);
      const m = Math.floor((timeSec % 3600) / 60);
      const s = timeSec % 60;
      return `<@${userId}> — **${h}h ${m}m ${s}s**`;
    });

    const finalMessage = `⏱️ **[Auto Report] Voice Time So Far Today**:\n\n${lines.join("\n")}`;

    try {
      const logChannel = await client.channels.fetch(VOICE_LOG_CHANNEL_ID);
      if (logChannel && logChannel.isTextBased()) {
        logChannel.send(finalMessage);
      }
    } catch (err) {
      console.error("❌ Failed to send auto voice report:", err);
    }
  }, 30 * 60 * 1000); // every 30 minutes
});

client.login(process.env.DISCORD_TOKEN);
