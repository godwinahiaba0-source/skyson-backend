// ==========================================
// TEAM REPORT & METRICS CONTROLLER
// ==========================================
const pool = require('./db');

const getTeamReport = async (req, res) => {
    const userId = req.user.id;

    try {
        // Fetch all downlines categorized by level directly from the team_referrals table
        const [referralRows] = await pool.query(
            `SELECT descendant_user_id, level FROM team_referrals WHERE ancestor_user_id = ? AND level IN (1, 2, 3)`,
            [userId]
        ).catch(() => [[], []]);

        const level1Ids = referralRows.filter(r => r.level === 1).map(r => r.descendant_user_id);
        const level2Ids = referralRows.filter(r => r.level === 2).map(r => r.descendant_user_id);
        const level3Ids = referralRows.filter(r => r.level === 3).map(r => r.descendant_user_id);

        const levelsMap = {
            1: level1Ids,
            2: level2Ids,
            3: level3Ids
        };

        let totalTeamRecharge = 0;
        let totalTeamWithdraw = 0;
        let totalFirstChargeCount = 0;
        let totalFirstPushCount = level1Ids.length; // Direct Level 1 invites/pushes
        
        const allTeamIds = referralRows.map(r => r.descendant_user_id);
        const totalTeamSize = allTeamIds.length;
        let totalNewTeamCount = totalTeamSize;

        const levelDetails = {};

        for (let lvl = 1; lvl <= 3; lvl++) {
            const ids = levelsMap[lvl];
            let lvlRechargeAmount = 0;
            let lvlRechargeNumber = 0;

            if (ids && ids.length > 0) {
                const placeholders = ids.map(() => '?').join(',');
                
                // Calculate total approved recharges for this specific level safely
                const [rechargeRows] = await pool.query(
                    `SELECT COALESCE(SUM(amount), 0) as total_recharge, COUNT(DISTINCT user_id) as recharge_count 
                     FROM deposits 
                     WHERE user_id IN (${placeholders}) AND status = 'approved'`,
                    ids
                ).catch(() => [[{ total_recharge: 0, recharge_count: 0 }]]);
                
                const row = Array.isArray(rechargeRows) ? rechargeRows[0] : rechargeRows;
                lvlRechargeAmount = parseFloat(row?.total_recharge || 0);
                lvlRechargeNumber = parseInt(row?.recharge_count || 0, 10);
            }

            levelDetails[lvl] = {
                rechargeAmount: lvlRechargeAmount,
                rechargeNumber: lvlRechargeNumber
            };
        }

        // Global team financial metrics across all levels (1, 2, 3)
        if (allTeamIds.length > 0) {
            const placeholders = allTeamIds.map(() => '?').join(',');

            const [globalRecharge] = await pool.query(
                `SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE user_id IN (${placeholders}) AND status = 'approved'`,
                allTeamIds
            ).catch(() => [[{ total: 0 }]]);
            const gRechargeRow = Array.isArray(globalRecharge) ? globalRecharge[0] : globalRecharge;
            totalTeamRecharge = parseFloat(gRechargeRow?.total || 0);

            const [globalWithdraw] = await pool.query(
                `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE user_id IN (${placeholders}) AND status = 'approved'`,
                allTeamIds
            ).catch(() => [[{ total: 0 }]]);
            const gWithdrawRow = Array.isArray(globalWithdraw) ? globalWithdraw[0] : globalWithdraw;
            totalTeamWithdraw = parseFloat(gWithdrawRow?.total || 0);

            const [firstCharge] = await pool.query(
                `SELECT COUNT(DISTINCT user_id) as cnt FROM deposits WHERE user_id IN (${placeholders}) AND status = 'approved'`,
                allTeamIds
            ).catch(() => [[{ cnt: 0 }]]);
            const fChargeRow = Array.isArray(firstCharge) ? firstCharge[0] : firstCharge;
            totalFirstChargeCount = parseInt(fChargeRow?.cnt || 0, 10);
        }

        res.json({
            success: true,
            teamRecharge: totalTeamRecharge,
            firstChargeCount: totalFirstChargeCount,
            teamSize: totalTeamSize,
            teamWithdraw: totalTeamWithdraw,
            firstPushCount: totalFirstPushCount,
            newTeamCount: totalNewTeamCount,
            levels: levelDetails
        });

    } catch (err) {
        console.error('Team report error:', err);
        res.status(500).json({ success: false, message: 'Failed to generate team report', error: err.message });
    }
};

module.exports = { getTeamReport };