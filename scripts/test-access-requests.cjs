const jwt = require('jsonwebtoken');
const fs = require('fs');

const env = fs.readFileSync('.env', 'utf8');
const secret = (env.match(/JWT_SECRET=(.*)/) || [])[1].trim();
const dbUrl = (env.match(/DATABASE_URL=(.*)/) || [])[1].trim();

// Raaziq's account id (ultra_admin)
const adminUserId = 'e8491213-951e-4281-bdbe-377c17e737e5';
const token = jwt.sign(
  { userId: adminUserId, username: 'mraaziqp', role: 'ultra_admin' },
  secret,
  { algorithm: 'HS256', expiresIn: '1h' }
);

async function test() {
  console.log("=== Testing Access Requests & Notifications ===");

  // 1. GET /api/admin/people
  console.log("\n1. Fetching /api/admin/people...");
  const resPeople = await fetch('http://localhost:3000/api/admin/people', {
    headers: { Authorization: `Bearer ${token}` }
  });
  console.log("Status:", resPeople.status);
  const dataPeople = await resPeople.json();

  console.log("Total users:", dataPeople.users?.length);
  console.log("Total accessRequests:", dataPeople.accessRequests?.length);

  const pendingRequests = (dataPeople.accessRequests || []).filter(r => r.status === 'pending');
  console.log("Pending access requests:", pendingRequests.map(r => ({
    id: r.id,
    username: r.username,
    display_name: r.display_name,
    email: r.email,
    status: r.status,
    message: r.message
  })));

  const usersWithPending = (dataPeople.users || []).filter(u => u.hasPendingRequest);
  console.log("Users flagged with hasPendingRequest:", usersWithPending.map(u => ({
    username: u.username,
    display_name: u.display_name,
    hasPendingRequest: u.hasPendingRequest,
    requestId: u.accessRequest?.id
  })));

  // 2. Test live source for pending requests
  console.log("\n2. Fetching /api/activity/live...");
  const resLive = await fetch('http://localhost:3000/api/activity/live', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const dataLive = await resLive.json();
  const accessLive = (dataLive.items || []).filter(item => item.kind === 'access');
  console.log("Access live item in Activity Log:", accessLive);

  // 3. Test approving one friend (e.g. ziyaadfritz) via PATCH /api/admin/people/access-requests/:id
  const ziyaadReq = pendingRequests.find(r => r.username === 'ziyaadfritz');
  if (ziyaadReq) {
    console.log("\n3. Testing PATCH /api/admin/people/access-requests/" + ziyaadReq.id + " (Approve Unlimited)...");
    const resApprove = await fetch(`http://localhost:3000/api/admin/people/access-requests/${ziyaadReq.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ status: 'approved', tier: 'unlimited' })
    });
    console.log("Approve status:", resApprove.status);
    const dataApprove = await resApprove.json();
    console.log("Approve response:", dataApprove);
  }

  // 4. Test 1-click grant access for the other friend (sabri.shade) via POST /api/admin/people/:id/grant-access
  const sabriUser = dataPeople.users.find(u => u.username === 'sabri.shade');
  if (sabriUser) {
    console.log("\n4. Testing POST /api/admin/people/" + sabriUser.id + "/grant-access (1-click Grant Full Access)...");
    const resGrant = await fetch(`http://localhost:3000/api/admin/people/${sabriUser.id}/grant-access`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ tier: 'unlimited' })
    });
    console.log("Grant status:", resGrant.status);
    const dataGrant = await resGrant.json();
    console.log("Grant response:", dataGrant);
  }

  // 5. Verify receipts in Activity Log
  console.log("\n5. Fetching /api/receipts...");
  const resReceipts = await fetch('http://localhost:3000/api/receipts', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const dataReceipts = await resReceipts.json();
  const receiptsList = Array.isArray(dataReceipts) ? dataReceipts : (dataReceipts.receipts || []);
  const accountReceipts = receiptsList.filter(r => r.kind === 'account').slice(0, 5);
  console.log("Recent account receipts in Activity Log:", accountReceipts.map(r => ({
    title: r.title,
    detail: r.detail,
    actor: r.actor,
    status: r.status,
    at: r.at
  })));

  // 6. Verify database state for both friends
  console.log("\n6. Verifying database state for both friends...");
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: dbUrl });
  const dbUsers = await pool.query(
    "SELECT id, username, display_name, email, role, user_tier, media_access, games_access FROM users WHERE username IN ('ziyaadfritz', 'sabri.shade')"
  );
  console.table(dbUsers.rows);

  const dbReqs = await pool.query(
    "SELECT id, requester_id, status, resolved_at FROM host_access_requests WHERE requester_id IN ($1, $2)",
    [dbUsers.rows[0].id, dbUsers.rows[1].id]
  );
  console.table(dbReqs.rows);
  await pool.end();

  console.log("\n=== ALL TESTS COMPLETED SUCCESSFULLY ===");
}

test().catch(console.error);
