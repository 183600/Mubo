import { createMuboApp } from "mubo";
import config from "../../mubo.config.ts";

const app = await createMuboApp(config);
await app.start();
console.log("Server started on port 3000");
