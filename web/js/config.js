// Supply Smile (Firebase) - where the database is.
// After creating your Firebase project (see README.md), copy two values from
// Firebase console -> Project settings (gear icon) -> General -> Your apps -> Web app -> SDK setup and configuration:
//   apiKey       -> firebaseApiKey
//   databaseURL  -> firebaseDatabaseUrl   (also shown at the top of Realtime Database -> Data)
// These values are meant to be public: who may read or change what is decided by database.rules.json.
window.SUPPLY_SMILE_CONFIG = {
  firebaseApiKey: 'your-api-key',
  firebaseDatabaseUrl: 'https://your-project-id.firebasedatabase.app',
  // Usernames are turned into sign-in names like meera@users.supplysmile.app (no email is ever sent).
  userEmailDomain: 'users.supplysmile.app'
};