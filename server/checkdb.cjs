const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, 'terminal.db');
const db = new sqlite3.Database(dbPath);

// CONFIGURATION
const myPhone = "254748022271"; // <--- Replace with your actual phone number
const refundAmount = 300000;     // <--- Amount to add back (e.g., 3 bets * 100 KES)

db.serialize(() => {
    // Update the balance by adding the refund amount to the current balance
    db.run(
        "UPDATE users SET balance = balance + ? WHERE phone = ?", 
        [refundAmount, myPhone], 
        function(err) {
            if (err) {
                console.error("❌ Refund failed:", err.message);
            } else if (this.changes === 0) {
                console.log("⚠️ No user found with that phone number. Check your 'terminal.db' user table.");
            } else {
                console.log(`✅ Success! KES ${refundAmount} has been added back to ${myPhone}.`);
                
                // Verify the new balance
                db.get("SELECT phone, balance FROM users WHERE phone = ?", [myPhone], (err, row) => {
                    if (row) console.log(`New Balance: KES ${row.balance}`);
                });
            }
        }
    );
});

db.close();