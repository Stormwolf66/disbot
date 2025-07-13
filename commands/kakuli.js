module.exports = {
  name: "kakuli",
  async execute(message, args) {
    const prompt = args.join(" ");
    const { handleKakuliCommandDiscord } = await import("../kakuli.js");
    await handleKakuliCommandDiscord(message, prompt);
  },
};
