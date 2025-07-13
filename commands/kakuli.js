module.exports = {
  name: "kakuli",
  async execute(message, args) {
    const prompt = args.join(" ");
    const { handleKakuliCommandDiscord } = require("../kakuli.js");
    await handleKakuliCommandDiscord(message, prompt);
  },
};
