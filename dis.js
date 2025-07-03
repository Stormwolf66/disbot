require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const ytdl = require("ytdl-core");
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

const voiceJoinMap = new Map();
const musicConnections = new Map(); // guildId -> connection

// Play join/leave sound for YOUR_USER_ID only (skip if music playing)
function playSound(channel, fileName) {
  const guildId = channel.guild.id;
  if (musicConnections.has(guildId)) return;

  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
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
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed)
      connection.destroy();
    return;
  }

  const timeout = setTimeout(() => {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed)
      connection.destroy();
  }, 15000);

  player.on(AudioPlayerStatus.Idle, () => {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed)
      connection.destroy();
    clearTimeout(timeout);
  });

  connection.on("stateChange", (_, newState) => {
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed)
        connection.destroy();
      clearTimeout(timeout);
    }
  });
}

// Add voice time for user for given day
async function addVoiceTime(userId, seconds, day) {
  const dateKey = day || new Date().toISOString().split("T")[0];
  const key = `voiceTime_${userId}_${dateKey}`;
  const current = (await db.get(key)) || 0;
  await db.set(key, current + seconds);
}

function getPreviousDayDateString() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split("T")[0];
}

// Voice state update handler - tracks join/leave and calls playSound for YOUR_USER_ID
client.on("voiceStateUpdate", async (oldState, newState) => {
  const userId = newState.id;
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;
  const now = Date.now();

  if (userId === YOUR_USER_ID && !musicConnections.has(newChannel?.guild?.id)) {
    if (!oldChannel && newChannel) playSound(newChannel, "join.mp3");
    else if (oldChannel && !newChannel) playSound(oldChannel, "leave.mp3");
    else if (oldChannel?.id !== newChannel?.id) playSound(newChannel, "join.mp3");
    return;
  }

  if (!oldChannel && newChannel) voiceJoinMap.set(userId, now);
  else if (oldChannel && !newChannel && voiceJoinMap.has(userId)) {
    const timeSpent = Math.floor((now - voiceJoinMap.get(userId)) / 1000);
    await addVoiceTime(userId, timeSpent);
    voiceJoinMap.delete(userId);
  } else if (oldChannel?.id !== newChannel?.id) {
    if (voiceJoinMap.has(userId)) {
      const timeSpent = Math.floor((now - voiceJoinMap.get(userId)) / 1000);
      await addVoiceTime(userId, timeSpent);
    }
    voiceJoinMap.set(userId, now);
  }
});

// Handle commands
client.on("messageCreate", async (msg) => {
  if (msg.author.bot || !msg.guild) return;

  // !voicetime command
  if (msg.content.startsWith("!voicetime")) {
    let dateArg = msg.content.split(" ")[1]?.toLowerCase();
    let day =
      dateArg === "yesterday"
        ? getPreviousDayDateString()
        : dateArg || new Date().toISOString().split("T")[0];

    const now = Date.now();
    // Update active voice users' time first
    for (const [uid, jt] of voiceJoinMap.entries()) {
      const timeSpent = Math.floor((now - jt) / 1000);
      await addVoiceTime(uid, timeSpent);
      voiceJoinMap.set(uid, now);
    }

    const all = await db.all();
    const lines = all
      .filter((d) => d.id.endsWith("_" + day))
      .map((d) => {
        const uid = d.id.split("_")[1];
        const t = d.value,
          h = Math.floor(t / 3600),
          m = Math.floor((t % 3600) / 60),
          s = t % 60;
        return `<@${uid}> — **${h}h ${m}m ${s}s**`;
      });

    return msg.channel.send(
      lines.length
        ? `📊 **Voice Time for ${day}**:\n\n${lines.join("\n")}`
        : `📭 No voice activity recorded for **${day}**.`
    );
  }

  // kakuli command to play YouTube audio
  if (msg.content.toLowerCase().startsWith("kakuli")) {
    const args = msg.content.trim().split(" ");
    const url = args[1];

    if (!url || !ytdl.validateURL(url)) {
      return msg.reply("❌ Please provide a valid YouTube link.");
    }

    const channel = msg.member?.voice?.channel;
    if (!channel)
      return msg.reply("❌ You must be in a voice channel to play music.");

    try {
      const stream = ytdl(url, { filter: "audioonly", quality: "highestaudio" });
      const resource = createAudioResource(stream);

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
      });

      const player = createAudioPlayer();
      connection.subscribe(player);
      player.play(resource);

      musicConnections.set(channel.guild.id, connection);

      player.on(AudioPlayerStatus.Idle, () => {
        musicConnections.delete(channel.guild.id);
        if (connection.state.status !== VoiceConnectionStatus.Destroyed)
          connection.destroy();
      });

      player.on("error", (error) => {
        console.error("❌ Audio Player Error:", error);
        if (connection.state.status !== VoiceConnectionStatus.Destroyed)
          connection.destroy();
      });

      msg.channel.send(`▶️ Now playing: ${url}`);
    } catch (err) {
      console.error("❌ Error playing music:", err);
      msg.reply("❌ Failed to play the video. Please try again.");
    }
  }
});

// Auto report voice time every 30 minutes
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  setInterval(async () => {
    const now = Date.now();
    const today = new Date().toISOString().split("T")[0];

    for (const [uid, jt] of voiceJoinMap.entries()) {
      const timeSpent = Math.floor((now - jt) / 1000);
      await addVoiceTime(uid, timeSpent);
      voiceJoinMap.set(uid, now);
    }

    const all = await db.all();
    const lines = all
      .filter((d) => d.id.endsWith("_" + today))
      .map((d) => {
        const uid = d.id.split("_")[1];
        const t = d.value,
          h = Math.floor(t / 3600),
          m = Math.floor((t % 3600) / 60),
          s = t % 60;
        return `<@${uid}> — **${h}h ${m}m ${s}s**`;
      });

    const channel = await client.channels.fetch(VOICE_LOG_CHANNEL_ID);
    if (channel?.isTextBased()) {
      channel.send(`⏱️ **[Auto Report] Voice Time So Far Today**:\n\n${lines.join("\n")}`);
    }
  }, 30 * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
