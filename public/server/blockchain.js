import dotenv from 'dotenv';
import 'dotenv/config';
import { ethers } from 'ethers';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, './.env') });
console.log("Checking .env load:", process.env.SOKO_CONTRACT_ADDRESS ? "✅ Loaded" : "❌ Still Missing");

// 1. Setup Environment Variables
const RPC_URL = process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology";
const CONTRACT_ADDRESS = process.env.SOKO_CONTRACT_ADDRESS;

// Use HOT_WALLET_PRIVATE_KEY as the source of truth
let rawKey = process.env.HOT_WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

// 2. Automatically fix the MetaMask "No 0x" issue & trim spaces
if (rawKey) {
    rawKey = rawKey.trim();
    if (!rawKey.startsWith('0x')) {
        rawKey = '0x' + rawKey;
    }
}

// 3. Setup Connection
const provider = new ethers.JsonRpcProvider(RPC_URL);

// 4. Initialize Admin Wallet safely
let adminWallet;
try {
    if (!rawKey || rawKey.length < 60) {
        throw new Error("Private Key is missing or invalid in .env");
    }
    adminWallet = new ethers.Wallet(rawKey, provider);
    console.log("✅ Blockchain Wallet Loaded:", adminWallet.address);
} catch (error) {
    console.error("❌ BLOCKCHAIN ERROR:", error.message);
    // Create a random wallet just so the server doesn't crash, 
    // though transactions will fail until the .env is fixed.
    adminWallet = ethers.Wallet.createRandom().connect(provider);
}

// 5. ERC-20 ABI
const SOKO_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "event Transfer(address indexed from, address indexed to, uint256 amount)"
];

// 6. Create Contract Instance
const sokoContract = new ethers.Contract(CONTRACT_ADDRESS, SOKO_ABI, adminWallet);

/**
 * EXPORTED FUNCTIONS
 */

export const getSokoBalance = async (address) => {
    try {
        if (!ethers.isAddress(address)) return "0";
        const balance = await sokoContract.balanceOf(address);
        const decimals = await sokoContract.decimals();
        return ethers.formatUnits(balance, decimals);
    } catch (error) {
        console.error("Error fetching balance:", error);
        return "0";
    }
};

export const sendSoko = async (toAddress, amount) => {
    try {
        if (!ethers.isAddress(toAddress)) throw new Error("Invalid recipient address");
        
        const decimals = await sokoContract.decimals();
        const parsedAmount = ethers.parseUnits(amount.toString(), decimals);

        // Fetch current fee data to avoid "Underpriced" errors
        const feeData = await provider.getFeeData();

        const tx = await sokoContract.transfer(toAddress, parsedAmount, {
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
            maxFeePerGas: feeData.maxFeePerGas
        });

        console.log("Transaction Hash:", tx.hash);
        const receipt = await tx.wait();
        return { success: true, hash: tx.hash, receipt };
    } catch (error) {
        console.error("Transfer failed:", error);
        return { success: false, error: error.message };
    }
};

export const isValidAddress = (address) => {
    return ethers.isAddress(address);
};

export const getAdminWalletAddress = () => adminWallet.address;

export default {
    getSokoBalance,
    sendSoko,
    isValidAddress,
    getAdminWalletAddress,
    sokoContract
};
