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
    "574028865613-b8apa4bcpai776gtsqm14mdej3iubeha.apps.googleusercontent.com",
  statsUrl: "https://stats.7028robotics.com",
  repository: "STMARobotics@32277731/Puncher@1443278208",
  tableName: "puncher-prod-records",
};
