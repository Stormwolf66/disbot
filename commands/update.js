const fs = require("fs");
const path = require("path");

module.exports = {
  name: "upload",
  async execute(message) {
    if (message.author.id !== process.env.OWNER_ID) {
      return message.reply("❌ Only the bot owner can upload sounds.");
    }

    const attachment = message.attachments.first();
    if (!attachment) {
      return message.reply("❌ Please attach a file named `join.mp3` or `leave.mp3`.");
    }

    const allowed = ["join.mp3", "leave.mp3"];
    const fileName = attachment.name;

    if (!allowed.includes(fileName)) {
      return message.reply("❌ You can only upload `join.mp3` or `leave.mp3`.");
    }

    const filePath = path.join(__dirname, "..", "sounds", fileName);

    try {
      const res = await fetch(attachment.url);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(filePath, buffer);
      return message.reply(`✅ Successfully replaced \`${fileName}\`.`);
    } catch (err) {
      console.error("Upload error:", err);
      return message.reply("❌ Failed to save the file.");
    }
  },
};
