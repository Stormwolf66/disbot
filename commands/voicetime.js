module.exports = {
  name: "voicetime",
  async execute(msg, args, db, voiceJoinMap) {
    const guildId = msg.guild.id;

    const botMember = msg.guild.members.me;
    const member = msg.member;

    if (args[0] === "channel") {
      if (member.roles.highest.position <= botMember.roles.highest.position) {
        return msg.channel.send("❌ You must have a higher role than the bot to set the voice log channel.");
      }

      const channelId = args[1];
      const channel = msg.guild.channels.cache.get(channelId);
      if (!channel || !channel.isTextBased()) {
        return msg.channel.send("❌ Invalid channel ID or not a text channel.");
      }

      await db.set(`voiceLogChannelId_${guildId}`, channelId);
      return msg.channel.send(`✅ Voice log channel set to <#${channelId}>.`);
    }

    const dateArg = args[0]?.toLowerCase();
    const today = new Date();
    const day =
      dateArg === "yesterday"
        ? new Date(today.setDate(today.getDate() - 1)).toISOString().split("T")[0]
        : !dateArg || dateArg === "today"
        ? new Date().toISOString().split("T")[0]
        : /^\d{4}-\d{2}-\d{2}$/.test(dateArg)
        ? dateArg
        : null;

    if (!day) return msg.channel.send("❌ Invalid date format.");

    const now = Date.now();
    for (const [key, joinTime] of voiceJoinMap.entries()) {
      if (!key.startsWith(guildId)) continue;
      const [, userId] = key.split("_");
      await db.set(
        `voiceTime_${guildId}_${userId}_${day}`,
        ((await db.get(`voiceTime_${guildId}_${userId}_${day}`)) || 0) + Math.floor((now - joinTime) / 1000)
      );
      voiceJoinMap.set(key, now);
    }

    const allData = await db.all();
    const filtered = allData.filter(
      (item) => item.id.startsWith(`voiceTime_${guildId}_`) && item.id.endsWith(`_${day}`)
    );

    if (!filtered.length) return msg.channel.send(`📭 No voice activity for **${day}**.`);

    const lines = filtered.map(({ id, value }) => {
      const userId = id.split("_")[2];
      const h = Math.floor(value / 3600);
      const m = Math.floor((value % 3600) / 60);
      const s = value % 60;
      return `<@${userId}> — **${h}h ${m}m ${s}s**`;
    });

    msg.channel.send(`📊 **Voice Time for ${day}**:\n\n${lines.join("\n")}`);
  },
};
