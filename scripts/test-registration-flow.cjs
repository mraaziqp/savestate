const fs = require('fs');
const { Pool } = require('pg');

const env = fs.readFileSync('.env', 'utf8');
const dbUrl = (env.match(/DATABASE_URL=(.*)/) || [])[1].trim();
const pool = new Pool({ connectionString: dbUrl });

async function testRegistration() {
  console.log("=== Testing Registration Flow with Auto Access Request ===");
  const testUsername = 'testfriend_' + Math.floor(Math.random() * 10000);
  const testEmail = testUsername + '@example.com';

  console.log(`Registering ${testUsername}...`);
  const res = await fetch('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: testUsername,
      displayName: 'Test Friend',
      password: 'Password123!Secure',
      email: testEmail
    })
  });
  console.log("Register response status:", res.status);
  const data = await res.json();
  console.log("Register response user:", data.user);

  // Check if host_access_requests got an entry
  const reqRow = await pool.query(
    "SELECT * FROM host_access_requests WHERE requester_id=$1",
    [data.user.id]
  );
  console.log("Auto-created host_access_requests row:", reqRow.rows);

  // Check activity receipts
  const recRow = await pool.query(
    "SELECT * FROM activity_receipts WHERE user_id=$1 ORDER BY at DESC LIMIT 1",
    [data.user.id]
  );
  console.log("Receipt created for registration:", recRow.rows);

  // Clean up test user
  await pool.query("DELETE FROM host_access_requests WHERE requester_id=$1", [data.user.id]);
  await pool.query("DELETE FROM activity_receipts WHERE user_id=$1", [data.user.id]);
  await pool.query("DELETE FROM users WHERE id=$1", [data.user.id]);
  console.log("Test user cleaned up successfully.");

  await pool.end();
  console.log("=== REGISTRATION TEST PASSED ===");
}

testRegistration().catch(e => {
  console.error(e);
  pool.end();
});
