import axios from 'axios';
import dotenv from 'dotenv';
import { WebhookClient, EmbedBuilder } from 'discord.js';
import readline from 'readline';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

dotenv.config();

// Initialize readline interface at the top
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Initialize webhook at the top as well
const webhook = new WebhookClient({ url: process.env.DISCORD_WEBHOOK_URL! });

// Load wallets from JSON file
function loadWallets(): Record<string, string> {
  try {
    const walletsPath = path.join(__dirname, 'wallets.json');
    const fileContent = readFileSync(walletsPath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (error) {
    console.error('Error loading wallets file:', error);
    return {};
  }
}

// Save wallets to JSON file
function saveWallets(wallets: Record<string, string>) {
  try {
    const walletsPath = path.join(__dirname, 'wallets.json');
    writeFileSync(walletsPath, JSON.stringify(wallets, null, 2));
    console.log('Wallets file updated successfully');
  } catch (error) {
    console.error('Error saving wallets file:', error);
  }
}

// Replace the NAMED_WALLETS constant with loaded data
const NAMED_WALLETS = loadWallets();

// Convert all keys to lowercase
const NORMALIZED_WALLETS: Record<string, string> = Object.entries(NAMED_WALLETS).reduce(
  (acc, [address, name]) => ({
    ...acc,
    [address.toLowerCase()]: name
  }), 
  {}
);

// Track last processed transaction hash for each wallet
const lastProcessedTx: Record<string, string> = {};

interface Transaction {
  hash: string;
  from: string;
  to: string;
  value: string;
  blockNumber: string;
  timeStamp: string;
  input: string;
}

// Add these at the top with other interfaces/constants
interface WalletState {
  isSpamming: boolean;
  lastTxBlock: number;
  lastNotifiedTxHash: string;
  lastStateChangeTime: number;
}

// Track state for each wallet
const walletStates: Record<string, WalletState> = {};

// At the top with other constants
const SETTINGS = {
  BLOCKS_THRESHOLD: 10,    // Look at last 10 blocks
  MIN_TX_COUNT: 3         // Need 3+ transactions to be considered spam
};

// Update API settings for multiple keys
const API_SETTINGS = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
  RATE_LIMIT_DELAY: 50,  // Reduced to 50ms since we have 5 keys (allows ~20 calls per second)
  CALLS_PER_KEY: 5,     // Each key allows 5 calls per second
  BATCH_SIZE: 5         // How many wallets to check in parallel
};

// Add at the top with other API-related constants
const API_KEYS = process.env.BASESCAN_API_KEY?.split(',') || [];
let currentApiKeyIndex = 0;
const lastApiCalls: number[] = Array(API_KEYS.length).fill(0);

// Function to get next API key in rotation
function getNextApiKey(): string {
  const key = API_KEYS[currentApiKeyIndex];
  currentApiKeyIndex = (currentApiKeyIndex + 1) % API_KEYS.length;
  return key;
}

// Update rate limiter to use the array
async function rateLimitedDelay() {
  const now = Date.now();
  const keyIndex = currentApiKeyIndex;
  const timeSinceLastCall = now - lastApiCalls[keyIndex];
  
  if (timeSinceLastCall < API_SETTINGS.RATE_LIMIT_DELAY) {
    await delay(API_SETTINGS.RATE_LIMIT_DELAY - timeSinceLastCall);
  }
  
  lastApiCalls[keyIndex] = Date.now();
}

// Function to check if transactions indicate spam activity
function isSpamActivity(transactions: Transaction[], address: string, currentBlock: number): { 
  shouldNotify: boolean; 
  type: 'start' | 'stop' | null; 
} {
  if (!walletStates[address]) {
    walletStates[address] = {
      isSpamming: false,
      lastTxBlock: 0,
      lastNotifiedTxHash: '',
      lastStateChangeTime: 0
    };
  }

  const state = walletStates[address];
  const now = Math.floor(Date.now() / 1000);

  // Get the 3 most recent transactions
  const recentTxs = transactions
    .slice(0, 3)
    .map(tx => ({
      block: Number(tx.blockNumber),
      timestamp: Number(tx.timeStamp),
      hash: tx.hash
    }))
    .sort((a, b) => b.block - a.block);

  if (recentTxs.length === 0) return { shouldNotify: false, type: null };

  // Skip if we've already notified about this transaction
  if (recentTxs[0].hash === state.lastNotifiedTxHash) {
    return { shouldNotify: false, type: null };
  }

  // Prevent rapid state changes (minimum 30 seconds between changes)
  if (now - state.lastStateChangeTime < 30) {
    return { shouldNotify: false, type: null };
  }

  const timeSinceLastTx = now - recentTxs[0].timestamp;
  const blocksSinceLastTx = currentBlock - recentTxs[0].block;

  // If we're currently spamming, only check for stop condition
  if (state.isSpamming) {
    if (blocksSinceLastTx > 20) {  // Only use block difference for stop condition
      state.isSpamming = false;
      state.lastNotifiedTxHash = recentTxs[0].hash;
      state.lastTxBlock = recentTxs[0].block;
      state.lastStateChangeTime = now;
      return { shouldNotify: true, type: 'stop' };
    }
    return { shouldNotify: false, type: null };
  }

  // Not currently spamming, check for start condition
  if (recentTxs.length >= 3) {
    const blockGaps = [
      recentTxs[0].block - recentTxs[1].block,
      recentTxs[1].block - recentTxs[2].block
    ];

    const isActiveSpam = blockGaps.every(gap => gap <= 3);

    if (isActiveSpam && blocksSinceLastTx <= 3) {  // Make sure it's recent activity
      state.isSpamming = true;
      state.lastNotifiedTxHash = recentTxs[0].hash;
      state.lastTxBlock = recentTxs[0].block;
      state.lastStateChangeTime = now;
      return { shouldNotify: true, type: 'start' };
    }
  }

  // Update block but don't change state or notify
  state.lastTxBlock = recentTxs[0].block;
  return { shouldNotify: false, type: null };
}

// Function to fetch transactions from Basescan
async function fetchTransactions(address: string, retryCount = 0): Promise<Transaction[]> {
  const url = `https://api.basescan.org/api`;
  
  try {
    await rateLimitedDelay();

    const response = await axios.get(url, {
      params: {
        module: 'account',
        action: 'txlist',
        address: address,
        startblock: 0,
        endblock: 99999999,
        page: 1,
        offset: 50,
        sort: 'desc',
        apikey: getNextApiKey()
      }
    });

    if (response.data.status === '1' && response.data.result) {
      return response.data.result.filter((tx: Transaction) => 
        tx.to.toLowerCase() === address.toLowerCase()
      );
    }

    // If we get here, the API returned success but no data
    return [];

  } catch (error: any) {
    if (retryCount < API_SETTINGS.MAX_RETRIES) {
      // Wait longer between retries
      await delay(API_SETTINGS.RETRY_DELAY * (retryCount + 1));
      return fetchTransactions(address, retryCount + 1);
    }
    
    console.error(`API request failed for ${address} after ${API_SETTINGS.MAX_RETRIES} retries`);
    return [];
  }
}

// Function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Function to send Discord notification
async function sendDiscordNotification(transaction: Transaction, spamState: string) {
  const explorerLink = `https://basescan.org/tx/${transaction.hash}`;
  const addressLink = `https://basescan.org/address/${transaction.to}`;
  const contractName = NORMALIZED_WALLETS[transaction.to.toLowerCase()] || 'Unknown Contract';

  const embed = new EmbedBuilder()
    .setTitle(spamState)
    .setDescription(`
**Contract:** ${contractName}
**View Contract:** [${transaction.to}](${addressLink})
**Latest TX:** [${transaction.hash}](${explorerLink})
**Block Number:** ${transaction.blockNumber}
    `)
    .setColor(spamState.includes("Started") ? 0xFF0000 : 0x00FF00)
    .setTimestamp();

  try {
    await webhook.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending Discord notification:', error);
  }
}

// Update startMonitoring function
async function startMonitoring() {
  console.log('Starting wallet monitoring...');
  
  updateExistingWallets();
  
  console.log('Initial tracking set up. Now monitoring for new transactions...');
  startCommandListener();

  // Single monitoring loop using batches
  setInterval(async () => {
    const walletAddresses = Object.keys(NORMALIZED_WALLETS);
    
    // Process all wallets in one batch
    await monitorWalletBatch(walletAddresses);
    await delay(1000); // 1 second delay between checks
  }, 1000);
}

// Update monitorWalletBatch to handle both notifications
async function monitorWalletBatch(addresses: string[]) {
  try {
    const currentBlock = await getCurrentBlockNumber();
    if (currentBlock === 0) return;

    const results = await Promise.all(
      addresses.map(address => fetchTransactions(address))
    );

    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i];
      const transactions = results[i];

      if (!transactions.length) continue;

      const { shouldNotify, type } = isSpamActivity(transactions, address, currentBlock);
      
      if (shouldNotify && type) {
        const latestTx = transactions[0];
        const message = type === 'start' 
          ? "⚠️ Spam Activity Started" 
          : "✅ Spam Activity Stopped";
        
        await sendDiscordNotification(latestTx, message);
      }
    }
  } catch (error) {
    console.error('Error in batch monitoring:', error);
  }
}

// Start the monitoring
startMonitoring().catch(console.error);

async function getCurrentBlockNumber(retryCount = 0): Promise<number> {
  try {
    await rateLimitedDelay();

    const response = await axios.get('https://api.basescan.org/api', {
      params: {
        module: 'proxy',
        action: 'eth_blockNumber',
        apikey: getNextApiKey()
      }
    });

    if (!response.data.result) {
      console.error('Block number API response:', response.data);
      throw new Error('Invalid API response');
    }

    return parseInt(response.data.result, 16);
  } catch (error: any) {
    if (retryCount < API_SETTINGS.MAX_RETRIES) {
      await delay(API_SETTINGS.RETRY_DELAY * (retryCount + 1));
      return getCurrentBlockNumber(retryCount + 1);
    }
    console.error('Error fetching block number:', error.message);
    // Return the last known block number or estimate it
    const lastKnownBlock = Math.max(...Object.values(walletStates)
      .map(state => state.lastTxBlock)
      .filter(block => block > 0));
    
    return lastKnownBlock > 0 ? lastKnownBlock : 24000000; // Fallback to base estimate
  }
}

// Add this interface at the top with other interfaces
interface DiscordEmbed {
  title?: string;
  color: number;
  timestamp?: string;
  fields: {
    name: string;
    value: string;
  }[];
}

// Update handleDiscordCommand function
async function handleDiscordCommand(content: string) {
  if (content === '!status') {
    const activeSpammers: string[] = [];
    const inactiveSpammers: string[] = [];

    for (const [address, fullName] of Object.entries(NAMED_WALLETS)) {
      const state = walletStates[address.toLowerCase()];
      
      // Split name and description
      const match = fullName.match(/^([^(]+)(?:\s*\((.*)\))?$/);
      const shortName = match ? match[1] : fullName;
      const description = match ? match[2] : '';

      // Create proper BaseScan link
      const formattedEntry = `• [${shortName}](https://basescan.org/address/${address})${description ? `\n  ${description}` : ''}`;

      if (state?.isSpamming) {
        activeSpammers.push(formattedEntry);
      } else {
        inactiveSpammers.push(formattedEntry);
      }
    }

    // Split into chunks of reasonable size
    const splitIntoChunks = (arr: string[], maxLength: number = 800): string[] => {
      const chunks: string[] = [];
      let currentChunk: string[] = [];
      let currentLength = 0;

      arr.forEach(item => {
        if (currentLength + item.length > maxLength) {
          chunks.push(currentChunk.join('\n\n'));
          currentChunk = [item];
          currentLength = item.length;
        } else {
          currentChunk.push(item);
          currentLength += item.length + 2;
        }
      });

      if (currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n\n'));
      }

      return chunks;
    };

    const activeChunks = splitIntoChunks(activeSpammers);
    const inactiveChunks = splitIntoChunks(inactiveSpammers);

    // Create embeds for each chunk
    const embeds: DiscordEmbed[] = [];

    // Add active spammers embeds
    activeChunks.forEach((chunk, index) => {
      embeds.push({
        title: index === 0 ? 'Spammer Status' : 'Active Spammers (continued)',
        color: 0x00ff00,
        timestamp: new Date().toISOString(),
        fields: [{
          name: '🟢 Active',
          value: chunk || 'None'
        }]
      });
    });

    // Add inactive spammers embeds
    inactiveChunks.forEach((chunk) => {
      embeds.push({
        color: 0x00ff00,
        fields: [{
          name: '🔴 Inactive',
          value: chunk || 'None'
        }]
      });
    });

    try {
      // Send each embed separately if there are multiple
      for (const embed of embeds) {
        await webhook.send({ embeds: [embed] });
        await delay(100);
      }
    } catch (error) {
      console.error('Error sending status:', error);
    }
  }
}

function startCommandListener() {
  rl.on('line', async (input) => {
    const [command, ...args] = input.trim().split(' ');
    
    switch (command) {
      case '!status':
        await handleDiscordCommand('!status');
        break;
      case '!add':
        if (args.length < 1) {
          console.log('Usage: !add <contract_address>');
          return;
        }
        await addNewWallet(args[0]);
        break;
    }
  });

  console.log('Commands available:');
  console.log('!status - Check spammer status');
  console.log('!add <address> - Add new contract to monitor');
}

// Function to add new wallet
async function addNewWallet(address: string) {
  if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
    console.log('Invalid address format');
    return;
  }

  const normalizedAddress = address.toLowerCase();
  
  if (NORMALIZED_WALLETS[normalizedAddress]) {
    console.log('This contract is already being monitored');
    return;
  }

  rl.question('Enter description (or press enter for none): ', async (description) => {
    const fullName = formatWalletName(address, description || undefined);
    
    // Add to NAMED_WALLETS and NORMALIZED_WALLETS
    NAMED_WALLETS[address] = fullName;
    NORMALIZED_WALLETS[normalizedAddress] = fullName;

    // Save updated wallets to file
    saveWallets(NAMED_WALLETS);

    // Initialize monitoring for the new wallet
    try {
      const transactions = await fetchTransactions(address);
      if (transactions.length > 0) {
        lastProcessedTx[address] = transactions[0].blockNumber;
      }
    } catch (error) {
      console.error(`Error initializing new wallet ${address}:`, error);
    }

    console.log(`Added new contract: ${fullName}`);
    console.log(`Address: ${address}`);
    console.log('Monitoring started for new wallet');
  });
}

function formatWalletName(address: string, description?: string): string {
  const shortAddress = address.slice(0, 7); // Gets "0x" plus first 5 characters
  return description ? `${shortAddress} (${description})` : shortAddress;
}

// Add this function
function updateExistingWallets() {
  const updatedWallets: Record<string, string> = {};
  
  for (const [address, fullName] of Object.entries(NAMED_WALLETS)) {
    // Extract description from current name
    const match = fullName.match(/^[^(]+\s*\((.*)\)$/);
    const description = match ? match[1] : '';
    
    // Update with new format
    updatedWallets[address] = formatWalletName(address, description);
  }

  // Save updated wallets
  saveWallets(updatedWallets);
  
  // Update in-memory wallets
  Object.assign(NAMED_WALLETS, updatedWallets);
  
  // Update normalized wallets
  Object.entries(updatedWallets).forEach(([address, name]) => {
    NORMALIZED_WALLETS[address.toLowerCase()] = name;
  });
}

// Add periodic status check
setInterval(async () => {
  const currentBlock = await getCurrentBlockNumber();
  const activeStates: string[] = [];

  for (const [address, state] of Object.entries(walletStates)) {
    if (state.isSpamming) {
      const blockDiff = currentBlock - state.lastTxBlock;
      const shortAddr = address.slice(0, 6);
      activeStates.push(`${shortAddr}: ${blockDiff} blocks behind (Last: ${state.lastTxBlock}, Current: ${currentBlock})`);
    }
  }

  if (activeStates.length > 0) {
    console.log('\n=== Active Spammers Status ===');
    console.log(activeStates.join('\n'));
    console.log('=============================\n');
  }
}, 5 * 60 * 1000); // Run every 5 minutes
