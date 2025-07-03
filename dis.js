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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const YOUR_USER_ID = process.env.OWNER_ID;

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

client.on("voiceStateUpdate", (oldState, newState) => {
  if (newState.id !== YOUR_USER_ID) return;

  const oldChannel = oldState.channel;
  const newChannel = newState.channel;

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
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
