require('dotenv').config();
const app = require('./index');

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Local API server running on http://localhost:${PORT}`);
});
