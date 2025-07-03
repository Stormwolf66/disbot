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
const ytdl = require("ytdl-core");
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
const musicConnections = new Map(); // tracks ongoing music to avoid join.mp3

function playSound(channel, fileName) {
  if (musicConnections.has(channel.guild.id)) return;

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
  connection.subscribe(player);
  player.play(resource);

  const timeout = setTimeout(() => {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }, 15000);

  player.on(AudioPlayerStatus.Idle, () => {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    clearTimeout(timeout);
  });

  connection.on("stateChange", (_, newState) => {
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      clearTimeout(timeout);
    }
  });
}

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

client.on("messageCreate", async (msg) => {
  if (msg.content.startsWith("!voicetime")) {
    let dateArg = msg.content.split(" ")[1]?.toLowerCase();
    let day = dateArg === "yesterday" ? getPreviousDayDateString() : (dateArg || new Date().toISOString().split("T")[0]);

    const now = Date.now();
    for (const [uid, jt] of voiceJoinMap.entries()) {
      const timeSpent = Math.floor((now - jt) / 1000);
      await addVoiceTime(uid, timeSpent);
      voiceJoinMap.set(uid, now);
    }

    const all = await db.all();
    const lines = all
      .filter(d => d.id.endsWith("_" + day))
      .map(d => {
        const uid = d.id.split("_")[1];
        const t = d.value, h = ~~(t / 3600), m = ~~((t % 3600) / 60), s = t % 60;
        return `<@${uid}> — **${h}h ${m}m ${s}s**`;
      });

    msg.channel.send(lines.length ? `📊 **Voice Time for ${day}**:\n\n${lines.join("\n")}` : `📭 No voice activity recorded for **${day}**.`);
  }

  if (msg.content.startsWith("kakuli ")) {
    const link = msg.content.split(" ")[1];
    if (!ytdl.validateURL(link)) return msg.reply("❌ Invalid YouTube link");
    if (!msg.member.voice.channel) return msg.reply("❌ You must be in a voice channel");

    try {
      const connection = joinVoiceChannel({
        channelId: msg.member.voice.channel.id,
        guildId: msg.guild.id,
        adapterCreator: msg.guild.voiceAdapterCreator,
      });
      musicConnections.set(msg.guild.id, true);
      const stream = ytdl(link, { filter: "audioonly" });
      const resource = createAudioResource(stream);
      const player = createAudioPlayer();
      connection.subscribe(player);
      player.play(resource);
      msg.react("🎶");

      player.on(AudioPlayerStatus.Idle, () => {
        connection.destroy();
        musicConnections.delete(msg.guild.id);
      });
    } catch (err) {
      msg.reply("❌ Failed to play the track");
      console.error(err);
    }
  }
});

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
      .filter(d => d.id.endsWith("_" + today))
      .map(d => {
        const uid = d.id.split("_")[1];
        const t = d.value, h = ~~(t / 3600), m = ~~((t % 3600) / 60), s = t % 60;
        return `<@${uid}> — **${h}h ${m}m ${s}s**`;
      });
    const channel = await client.channels.fetch(VOICE_LOG_CHANNEL_ID);
    if (channel?.isTextBased()) channel.send(`⏱️ **[Auto Report] Voice Time So Far Today**:\n\n${lines.join("\n")}`);
  }, 30 * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
