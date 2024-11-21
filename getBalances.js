const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const fs = require('fs');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();  // Load environment variables from .env

// Telegram Bot Setup from .env file
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Load Solana public key from .env file
const SOLANA_PUBLIC_KEY = process.env.SOLANA_PUBLIC_KEY;
const publicKey = new PublicKey(SOLANA_PUBLIC_KEY);  // Convert string to PublicKey object

// Set up connection to the Solana cluster (mainnet, testnet, or devnet)
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const RAYDIUM_API_URL = 'https://api-v3.raydium.io/mint/price';

// Previous market caps file to track changes between runs
const PREVIOUS_MARKET_CAPS_FILE = 'tmp_data_previous.json';

async function getAllTokenBalances() {
    try {
        // Fetch all token accounts owned by the wallet
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
            publicKey,
            { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
        );

        const mintAddresses = [];
        tokenAccounts.value.forEach((tokenAccount) => {
            const accountInfo = tokenAccount.account.data.parsed.info;
            const mintAddress = accountInfo.mint;
            const tokenAmount = accountInfo.tokenAmount;

            // Only consider tokens with a balance greater than 0
            if (tokenAmount.uiAmount > 0) {
                mintAddresses.push(mintAddress);
            }
        });

        if (mintAddresses.length > 0) {
            // Process the mint addresses in batches of 99
            const batches = chunkArray(mintAddresses, 99);

            const bondedCoins = [];
            const unbondedCoins = [];
            const currentMarketCaps = {};

            // Loop over batches and fetch prices for each
            for (const batch of batches) {
                const mintList = batch.join(',');
                const prices = await fetchTokenPrices(mintList);

                // Process each mint and classify into bonded or unbonded
                batch.forEach((mint) => {
                    const priceData = prices[mint];
                    if (priceData) {
                        const marketCap = parseFloat(priceData) * 1e9;  // Multiply by 1 billion
                        bondedCoins.push({ mint, marketCap });
                        currentMarketCaps[mint] = marketCap;
                    } else {
                        unbondedCoins.push({ mint });
                    }
                });
            }

            // Sort bonded coins by market cap in descending order
            bondedCoins.sort((a, b) => b.marketCap - a.marketCap);

            // Save data to CSV files
            saveToCSV(bondedCoins, 'tmp_data_bonded.csv', true);
            saveToCSV(unbondedCoins, 'tmp_data_unbonded.csv', false);

            // Track and compare market cap changes
            trackMarketCapChanges(currentMarketCaps);

            // Output sorted coins to the console
            console.log("Coins with the highest market cap:");
            bondedCoins.forEach((coin) => {
                console.log(`Mint: ${coin.mint}, Market Cap: ${coin.marketCap}`);
            });
        } else {
            console.log('No tokens with a balance above 0.');
        }
    } catch (error) {
        console.error('Failed to fetch token balances:', error);
    }
}

async function fetchTokenPrices(mintList) {
    try {
        const response = await axios.get(`${RAYDIUM_API_URL}?mints=${mintList}`);
        return response.data.data;  // Return the 'data' part of the response containing mint-to-price mappings
    } catch (error) {
        console.error('Error fetching prices from Raydium API:', error);
        return {};  // Return an empty object if the API request fails
    }
}

// Utility function to chunk an array into smaller arrays of a specified size
function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

// Save data to CSV files
function saveToCSV(data, fileName, isBonded) {
    const headers = isBonded ? 'Mint,MarketCap\n' : 'Mint\n';
    let csvContent = headers;

    data.forEach((coin) => {
        if (isBonded) {
            csvContent += `${coin.mint},${coin.marketCap}\n`;
        } else {
            csvContent += `${coin.mint}\n`;
        }
    });

    fs.writeFileSync(fileName, csvContent, { encoding: 'utf8' });
    console.log(`Data saved to ${fileName}`);
}

// Define tranches based on market cap
function getMarketCapTranche(marketCap) {
    if (marketCap < 100000) return 'unbonded-bonded';
    if (marketCap < 500000) return '0-100k';
    if (marketCap < 1000000) return '100k-500k';
    if (marketCap < 3000000) return '500k-1M';
    if (marketCap < 10000000) return '1M-3M';
    if (marketCap < 20000000) return '3M-10M';
    return '10M-20M';
}

// Track market cap changes and compare with the previous run
function trackMarketCapChanges(currentMarketCaps) {
    let previousData = {};

    // Check if previous market caps exist
    if (fs.existsSync(PREVIOUS_MARKET_CAPS_FILE)) {
        previousData = JSON.parse(fs.readFileSync(PREVIOUS_MARKET_CAPS_FILE));
    }

    // Compare current and previous market caps
    for (const mint in currentMarketCaps) {
        const currentCap = currentMarketCaps[mint];
        const previousCap = previousData[mint];

        if (previousCap === undefined) {
            // This token is newly bonded
            notifyTelegram(mint, 'unbonded-bonded', currentCap);
        } else {
            const currentTranche = getMarketCapTranche(currentCap);
            const previousTranche = getMarketCapTranche(previousCap);

            if (currentTranche !== previousTranche) {
                // Tranche change detected, notify
                notifyTelegram(mint, currentTranche, currentCap);
            }
        }
    }

    // Save the current market caps for the next comparison
    fs.writeFileSync(PREVIOUS_MARKET_CAPS_FILE, JSON.stringify(currentMarketCaps, null, 2));
}

// Send Telegram notification
function notifyTelegram(mint, tranche, marketCap) {
    const message = `Coin with Mint: ${mint} has moved to tranche: ${tranche} with Market Cap: ${marketCap}`;
    bot.sendMessage(CHAT_ID, message);
}

// Schedule the script to run every hour
cron.schedule('0 * * * *', () => {
    console.log('Running the script...');
    getAllTokenBalances();
});

// Initial run
getAllTokenBalances();
