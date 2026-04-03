export const config = {
  port: parseInt(process.env.PORT || '1306', 10),
  apiKey: process.env.API_KEY || '',
  dataDir: process.env.DATA_DIR || './data',
};
