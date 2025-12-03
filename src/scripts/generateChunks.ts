import dotenv from 'dotenv';
import { EnvUtils } from '../utils/EnvUtils';

if (!process.env.MONGO_URI) {
  dotenv.config({ path: "src/config/.env" });
}

const run = () => {
  const KEY_NAME = 'FIREBASE_SERVICE_ACCOUNT';
  const fullValue = process.env[KEY_NAME];

  if (!fullValue) {
    console.error(`❌ Error: ${KEY_NAME} not found in your local .env file.`);
    return;
  }

  console.log(`\n✂️  Splitting ${KEY_NAME} (Total Length: ${fullValue.length})...\n`);

  const chunks = EnvUtils.splitEnvValue(KEY_NAME, fullValue);

  // Output specifically formatted for you to read/copy
  Object.entries(chunks).forEach(([key, val]) => {
    console.log(`${key}= ${val}`);
  });

  console.log('\n✅ JSON Output (Copy this object to use in scripts if needed):');
  // console.log(JSON.stringify(chunks, null, 2));
};

run();