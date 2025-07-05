module.exports = {
  name: "snips",
  description: "Show the last 50 deleted messages in this server (only in snipe channel).",
  async execute(message, args, db) {
    const snipeChannelId = await db.get(`snipeChannel_${message.guild.id}`);
    if (!snipeChannelId || message.channel.id !== snipeChannelId) return;

    const snipes = await db.get(`snipe_${message.guild.id}`);
    if (!snipes || snipes.length === 0) {
      return message.reply("❌ No deleted messages recorded yet.");
    }

    const results = [];

    for (const snipe of snipes.slice(0, 50)) {
      const authorMember = await message.guild.members.fetch(snipe.authorId).catch(() => null);
      const invokerMember = message.member;

      if (
        !authorMember ||
        invokerMember.roles.highest.position > authorMember.roles.highest.position ||
        invokerMember.id === snipe.authorId
      ) {
        const time = `<t:${Math.floor(snipe.timestamp / 1000)}:R>`;
        results.push(
          `**${snipe.author}** (${snipe.authorId}) — ${time}\n\`\`\`${snipe.content || "Empty Message"}\`\`\``
        );
      }
    }

    if (results.length === 0) {
      return message.reply("⚠️ You don't have permission to view any recent deleted messages.");
    }

    message.reply({
      content: results.join("\n").slice(0, 2000), // Discord message limit
      allowedMentions: { repliedUser: false },
    });
  },
};
