import express from "express";
import cors from "cors";
import { config } from "./config/env";
import { healthRouter } from "./routes/health";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/health", healthRouter);

app.listen(config.port, () => {
  console.log(`Laxu backend listening on port ${config.port}`);
});
