require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
//middleware
app.use(cors());
app.use(express.json());

//db
mongoose.connect(
  process.env.MONGO_URI
)
.then(() => console.log("MongoDB Connected"))
.catch(err => console.log(err));

const SensorData = require("./models/SensorData");

app.post("/data", async (req, res) => {
  try {
    await SensorData.create(req.body);
    res.status(200).send("Data Stored");
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.get("/data/recent", async (req, res) => {
  try {
    const { deviceId, seconds } = req.query;

    if (!deviceId || !seconds) {
      return res.status(400).json({
        error: "deviceId and seconds are required"
      });
    }

    const windowTime = parseInt(seconds) * 1000;
    const windowStart = new Date(Date.now() - windowTime);

    const data = await SensorData.find({
      deviceId: deviceId,
      timestamp: { $gte: windowStart }
    })
      .sort({ timestamp: 1 })
      .lean();

    res.status(200).json({
      deviceId,
      windowSeconds: seconds,
      count: data.length,
      data
    });

  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.use("/api", require("./routes/dashboard"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});