const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 1. Double-check your filename! Is it 'database.db' or 'polysoko.db'?
const dbPath = path.resolve(__dirname, 'terminal.db'); 
const db = new sqlite3.Database(dbPath);

console.log("Attempting to connect to:", dbPath);

db.serialize(() => {
    const userPhone = '254740650864';
    const totalRefund = 100000;

    // Check if the table actually exists first
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'", (err, row) => {
        if (!row) {
            console.error("❌ ERROR: Could not find 'users' table. Are you sure 'terminal.db' is the right filename?");
            process.exit(1);
        }

        // 2. Update the balance
        db.run(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [totalRefund, userPhone], (err) => {
            if (err) console.error("Update Error:", err.message);
            else console.log(`✅ Success: ${totalRefund} SokoShillings restored to ${userPhone}.`);
        });

        // 3. Log the refund
        const refundNote = "REFUND_MAIL_FAIL";
        db.run(`INSERT INTO transactions (user_phone, type, amount, status, reference) 
                VALUES (?, 'refund', 200, 'completed', ?)`, [userPhone, `${refundNote}_1_${Date.now()}`]);
        
        db.run(`INSERT INTO transactions (user_phone, type, amount, status, reference) 
                VALUES (?, 'refund', 200, 'completed', ?)`, [userPhone, `${refundNote}_2_${Date.now()}`], (err) => {
            if (!err) console.log("✅ Two refund entries added to history.");
            db.close();
        });
    });
});