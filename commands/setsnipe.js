module.exports = {
  name: "setsnipe",
  description: "Set a private channel to show deleted messages (snipes).",
  async execute(message, args, db) {
    if (!message.member.permissions.has("Administrator")) {
      return message.reply("❌ You must be an administrator to use this command.");
    }

    const channel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]) || message.channel;

    if (!channel || !channel.isTextBased()) {
      return message.reply("❌ Please mention a valid text channel.");
    }

    await db.set(`snipeChannel_${message.guild.id}`, channel.id);
    message.reply(`✅ Snipes will now be shown in <#${channel.id}>.`);
  },
};
