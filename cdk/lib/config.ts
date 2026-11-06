export interface Config {
  account: string;
  domain: string;
  zoneName: string;
  zoneId: string;
  googleClientId: string;
  statsUrl: string;
  repository: string;
  tableName: string;
}

export const config: Config = {
  account: "738044534240",
  domain: "puncher.7028robotics.com",
  zoneName: "7028robotics.com",
  zoneId: "Z014656337LGZWAE9JKJP",
  googleClientId:
    "574028865613-h0k3s1dn8k1vkjpq7gv4ht7laivj0h38.apps.googleusercontent.com",
  statsUrl: "https://stats.7028robotics.com",
  repository: "STMARobotics@32277731/Puncher@1443278208",
  tableName: "puncher-data",
};
