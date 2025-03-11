import axios from 'axios';
import dotenv from 'dotenv';
import { WebhookClient, EmbedBuilder } from 'discord.js';

dotenv.config();

const webhook = new WebhookClient({ url: process.env.DISCORD_WEBHOOK_URL! });

// Define deployer wallets with their names
const DEPLOYER_WALLETS: Record<string, string> = {
  "0x75Fc48B5354CDda1B9717615bf311bF48F2CD733": "Deployer 1",
  "0xf943EBFA33d63376123335ad2096AEe6d3aC1374": "Deployer 2", 
  "0xB9e330591644f7def5c79Ca3C151b1dC0E0Ce502": "Deployer 3"
};

// Track last processed transaction for each wallet
const lastProcessedTx: Record<string, string> = {};

interface Transaction {
  hash: string;
  from: string;
  to: string;
  input: string;
  value: string;
  blockNumber: string;
  timeStamp: string;
}

async function fetchTransactions(address: string): Promise<Transaction[]> {
  try {
    const response = await axios.get('https://api.basescan.org/api', {
      params: {
        module: 'account',
        action: 'txlist',
        address: address,
        startblock: 0,
        endblock: 99999999,
        page: 1,
        offset: 10,
        sort: 'desc',
        apikey: process.env.BASESCAN_API_KEY
      }
    });

    if (response.data.status === '1' && response.data.result) {
      return response.data.result;
    }
    return [];
  } catch (error) {
    console.error(`Error fetching transactions for ${address}:`, error);
    return [];
  }
}

async function sendDiscordNotification(tx: Transaction, walletName: string) {
  // Convert wei to ETH
  const ethValue = Number(tx.value) / 1e18;
  
  const embed = new EmbedBuilder()
    .setTitle(`${walletName} Transaction Detected`)
    .setColor(0x00ff00)
    .setDescription(`
**From:** [${tx.from}](https://basescan.org/address/${tx.from})
**To:** [${tx.to}](https://basescan.org/address/${tx.to})
**Value:** ${ethValue.toFixed(4)} ETH
**TX:** [View Transaction](https://basescan.org/tx/${tx.hash})
    `)
    .setTimestamp();

  try {
    await webhook.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending Discord notification:', error);
  }
}

async function monitorWallets() {
  const addresses = Object.keys(DEPLOYER_WALLETS);

  for (const address of addresses) {
    const transactions = await fetchTransactions(address);
    
    if (transactions.length > 0) {
      const latestTx = transactions[0];
      
      // If we haven't seen this transaction before
      if (!lastProcessedTx[address] || lastProcessedTx[address] !== latestTx.hash) {
        lastProcessedTx[address] = latestTx.hash;
        await sendDiscordNotification(latestTx, DEPLOYER_WALLETS[address]);
      }
    }
  }
}

// Start monitoring
console.log('Starting deployer wallet monitoring...');
monitorWallets();

// Continue monitoring every second
setInterval(monitorWallets, 1000);
