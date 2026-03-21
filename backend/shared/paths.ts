import os from "os";
import path from "path";

export const envFilePath = path.join(os.homedir(), "SmartTeachAgent", ".env");
export const configFilePath = path.join(os.homedir(), "SmartTeachAgent", "config.json");
