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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const YOUR_USER_ID = process.env.OWNER_ID;
const VOICE_LOG_CHANNEL_ID = process.env.VOICE_LOG_CHANNEL_ID;
const voiceJoinMap = new Map();

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

// ⌛ Store time in DB
async function addVoiceTime(userId, seconds) {
  const today = new Date().toISOString().split("T")[0];
  const key = `voiceTime_${userId}_${today}`;
  const current = (await db.get(key)) || 0;
  await db.set(key, current + seconds);
}

// 🎧 Track join/leave/move of all users
client.on("voiceStateUpdate", async (oldState, newState) => {
  const userId = newState.id;
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;

  // For OWNER sound playback
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

  const now = Date.now();

  if (!oldChannel && newChannel) {
    voiceJoinMap.set(userId, now);
  } else if (oldChannel && !newChannel) {
    if (voiceJoinMap.has(userId)) {
      const joinTime = voiceJoinMap.get(userId);
      const timeSpent = Math.floor((now - joinTime) / 1000);
      await addVoiceTime(userId, timeSpent);
      voiceJoinMap.delete(userId);
    }
  } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
    if (voiceJoinMap.has(userId)) {
      const joinTime = voiceJoinMap.get(userId);
      const timeSpent = Math.floor((now - joinTime) / 1000);
      await addVoiceTime(userId, timeSpent);
    }
    voiceJoinMap.set(userId, now);
  }
});

// 📊 Manual command to check voice time
client.on("messageCreate", async (msg) => {
  if (msg.content === "!voicetime") {
    const today = new Date().toISOString().split("T")[0];
    const data = await db.all();

    const lines = data
      .filter((item) => item.id.includes(`_${today}`))
      .map((item) => {
        const userId = item.id.split("_")[1];
        const timeSec = item.value;
        const minutes = Math.floor(timeSec / 60);
        return `<@${userId}> — **${minutes}** minute${minutes !== 1 ? "s" : ""}`;
      });

    const finalMessage = lines.length
      ? `📊 **Voice Time Today**:\n\n${lines.join("\n")}`
      : "📭 No voice activity recorded today.";

    msg.channel.send(finalMessage);
  }
});

// 🔄 Auto-update and report every 30 minutes
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  setInterval(async () => {
    const now = Date.now();
    const today = new Date().toISOString().split("T")[0];

    for (const [userId, joinTime] of voiceJoinMap.entries()) {
      const timeSpent = Math.floor((now - joinTime) / 1000);
      await addVoiceTime(userId, timeSpent);
      voiceJoinMap.set(userId, now);
    }

    const data = await db.all();
    const lines = data
      .filter((item) => item.id.includes(`_${today}`))
      .map((item) => {
        const userId = item.id.split("_")[1];
        const timeSec = item.value;
        const minutes = Math.floor(timeSec / 60);
        return `<@${userId}> — **${minutes}** minute${minutes !== 1 ? "s" : ""}`;
      });

    const finalMessage = lines.length
      ? `⏱️ **[Auto Report] Voice Time So Far Today**:\n\n${lines.join("\n")}`
      : "📭 No voice activity recorded yet today.";

    try {
      const logChannel = await client.channels.fetch(VOICE_LOG_CHANNEL_ID);
      if (logChannel && logChannel.isTextBased()) {
        logChannel.send(finalMessage);
      }
    } catch (err) {
      console.error("❌ Failed to send auto voice report:", err);
    }
  }, 1000 * 60 * 30); // Every 30 mins
});

client.login(process.env.DISCORD_TOKEN);
