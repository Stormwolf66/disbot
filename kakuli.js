const fetch = require("node-fetch");
const fs = require("fs/promises");
const path = require("path");
require("dotenv").config();

const GEMINI_IMAGE_API_KEY = process.env.GEMINI_API_KEY;

async function handleKakuliCommandDiscord(message, prompt) {
  if (!prompt) {
    await message.reply("❌ Please provide a description after `!kakuli`.");
    return;
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${GEMINI_IMAGE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
      }
    );

    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((p) => p.inlineData?.data);

    if (!imagePart) {
      await message.reply("❌ No image could be generated. Try a different prompt.");
      return;
    }

    const buffer = Buffer.from(imagePart.inlineData.data, "base64");
    const imagePath = path.resolve("kakuli-gemini.png");
    await fs.writeFile(imagePath, buffer);

    await message.channel.send({
      files: [{ attachment: imagePath, name: "kakuli.png" }],
      content: "Your loving girl Kakuli's AI-crafted image ❤️",
    });

    await fs.unlink(imagePath);
  } catch (error) {
    console.error("Kakuli Discord Error:", error);
    await message.reply("❌ Kakuli failed to generate an image.");
  }
}

module.exports = { handleKakuliCommandDiscord };
