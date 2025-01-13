const { Connection, PublicKey } = require('@solana/web3.js');
const fetch = require('node-fetch');
const config = require('./config');
const wsClient = require('./websocket-client');
const fs = require('fs');

// Set to store previously purchased tokens
const purchasedTokens = new Set();

// Load previously purchased tokens from file if it exists
try {
    if (fs.existsSync('purchased_tokens.json')) {
        const data = fs.readFileSync('purchased_tokens.json', 'utf8');
        const tokens = JSON.parse(data);
        tokens.forEach(token => purchasedTokens.add(token));
    }
} catch (error) {
    console.error('Error loading purchased tokens:', error.message);
}

// Function to save purchased tokens to file
function savePurchasedTokens() {
    try {
        fs.writeFileSync('purchased_tokens.json', JSON.stringify(Array.from(purchasedTokens), null, 2));
    } catch (error) {
        console.error('Error saving purchased tokens:', error.message);
    }
}

// Connect to WebSocket server
wsClient.connect();

// Store original console methods
const originalConsole = {
    log: console.log,
    error: console.error
};

// Override console.log to send to web interface
console.log = function() {
    const text = Array.from(arguments).join(' ');
    originalConsole.log.apply(console, arguments);
    wsClient.sendToWeb('log', text);
};

// Override console.error to send to web interface
console.error = function() {
    const text = Array.from(arguments).join(' ');
    originalConsole.error.apply(console, arguments);
    wsClient.sendToWeb('log', 'Error: ' + text);
};

async function getTokenProfiles() {
    try {
        console.log('Fetching latest token profiles...');
        const url = 'https://api.dexscreener.com/token-profiles/latest/v1';
        console.log('Request URL:', url);

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            console.error('Response status:', response.status);
            console.error('Response headers:', response.headers);
            const text = await response.text();
            console.error('Response text:', text.substring(0, 200) + '...'); // First 200 chars
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const jsonData = await response.json();

        if (!Array.isArray(jsonData) || jsonData.length === 0) {
            console.error("No valid token data found");
            return [];
        }

        let allPairs = [];
        console.log("Fetching detailed token data...");

        for (const token of jsonData) {
            // Skip if token was already purchased
            if (purchasedTokens.has(token.tokenAddress)) {
                console.log(`Skipping ${token.tokenAddress} - already purchased before`);
                continue;
            }

            const searchUrl = `https://api.dexscreener.com/latest/dex/search?q=${token.tokenAddress}`;
            const searchResponse = await fetch(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'application/json'
                }
            });

            if (!searchResponse.ok) continue;

            const searchResult = await searchResponse.json();

            if (searchResult?.pairs?.[0]?.chainId === 'solana' &&
                searchResult.pairs[0].marketCap &&
                (searchResult.pairs[0].quoteToken.symbol === 'USDC' ||
                 searchResult.pairs[0].quoteToken.symbol === 'SOL')) {

                const pair = searchResult.pairs[0];
                const tokenData = {
                    address: token.tokenAddress,
                    name: pair.baseToken.name,
                    symbol: pair.baseToken.symbol,
                    liquidity: pair.liquidity?.usd || 0,
                    volume24h: pair.volume?.h24 || 0,
                    marketCap: pair.marketCap || 0,
                    priceUsd: parseFloat(pair.priceUsd) || 0,
                    createdAt: pair.pairCreatedAt,
                    description: token.description
                };

                allPairs.push(tokenData);
                console.log(`Found promising token: ${tokenData.name} (${tokenData.symbol})`);
                console.log(`• Address: ${tokenData.address}`);
                console.log(`• Market Cap: $${tokenData.marketCap.toLocaleString()}`);
                console.log(`• Liquidity: $${tokenData.liquidity.toLocaleString()}`);
                console.log('');
            }
        }

        // Filter and sort tokens
        const solanaTokens = allPairs
            .filter(token => token.marketCap >= 20000 && token.marketCap < 2000000 && token.liquidity >= 10000)
            .sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0));

        console.log(`Found ${solanaTokens.length} suitable Solana tokens\n`);

        return solanaTokens;
    } catch (error) {
        console.error('Error fetching token profiles:', error.message);
        return [];
    }
}

async function getTokenOrders(tokenAddress) {
    try {
        const response = await fetch(`https://api.dexscreener.com/orders/v1/solana/${tokenAddress}`);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error(`Error fetching orders for ${tokenAddress}:`, error.message);
        return null;
    }
}

async function getDexScreenerInfo(tokenAddress) {
    try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!data.pairs || data.pairs.length === 0) {
            console.log(`No pairs found for token ${tokenAddress}`);
            return null;
        }

        // Get the pair with highest liquidity and USDC or SOL as quote token
        const validPairs = data.pairs.filter(pair =>
            pair.quoteToken.symbol === 'USDC' || pair.quoteToken.symbol === 'SOL'
        );

        if (validPairs.length === 0) {
            console.log(`No valid pairs found for token ${tokenAddress}`);
            return null;
        }

        // only buy tokens coming from pumpfun
        const isPumpFun = data.pairs.find(pair => pair.dexId === 'pumpfun');
        if(!isPumpFun) {
            console.log('[Scanner] Token NOT from PUMPFUN skipping...');
            return null;
        }
        console.log('[Scanner] Token is from PUMPFUN returning info');

        const mainPair = validPairs.sort((a, b) => {
            const liquidityA = a.liquidity?.usd || 0;
            const liquidityB = b.liquidity?.usd || 0;
            return liquidityB - liquidityA;
        })[0];

        return {
            marketCap: mainPair.marketCap || 0,
            priceUsd: parseFloat(mainPair.priceUsd) || 0,
            liquidity: mainPair.liquidity?.usd || 0,
            volume24h: mainPair.volume?.h24 || 0,
            priceChange24h: mainPair.priceChange?.h24 || 0,
            createdAt: mainPair.pairCreatedAt,
            dexId: mainPair.dexId,
            quoteToken: mainPair.quoteToken.symbol
        };
    } catch (error) {
        console.error('Error fetching DexScreener info:', error.message);
        return null;
    }
}

function analyzeToken(tokenInfo) {
    let score = 0;

    // Market Cap Score (0-30 points)
    if (tokenInfo.marketCap >= 1000000) score += 30;
    else if (tokenInfo.marketCap >= 500000) score += 20;
    else if (tokenInfo.marketCap >= 100000) score += 10;

    // Liquidity Score (0-30 points)
    if (tokenInfo.liquidity >= 100000) score += 30;
    else if (tokenInfo.liquidity >= 50000) score += 20;
    else if (tokenInfo.liquidity >= 10000) score += 10;

    // Volume Score (0-20 points)
    if (tokenInfo.volume24h >= tokenInfo.marketCap * 0.2) score += 20;
    else if (tokenInfo.volume24h >= tokenInfo.marketCap * 0.1) score += 10;

    // Volatility Score (0-20 points)
    const absChange = Math.abs(tokenInfo.priceChange24h);
    if (absChange >= 5 && absChange <= 50) score += 20;
    else if (absChange > 50) score += 10;

    return score;
}

async function findBestToken() {
    console.log('\nStarting token analysis...');

    const tokens = await getTokenProfiles();
    let tokenMetrics = [];

    console.log(`\nAnalyzing ${tokens.length} tokens for trading opportunities...`);

    for (const token of tokens) {
        // Get fresh market data
        const tokenInfo = await getDexScreenerInfo(token.address);
        if (!tokenInfo) {
            console.log('No market data available, skipping...');
            continue;
        }

        // Calculate age in hours
        const createdAt = new Date(tokenInfo.createdAt);
        const now = new Date();
        const ageInHours = (now - createdAt) / (1000 * 60 * 60);

        // Skip tokens older than 48 hours
        if (ageInHours > 48) {
            console.log(`Token too old (${Math.round(ageInHours)} hours), skipping...`);
            continue;
        }

        // Calculate per hour metrics
        const marketCapPerHour = tokenInfo.marketCap / ageInHours;
        const liquidityPerHour = tokenInfo.liquidity / ageInHours;
        const volumePerHour = tokenInfo.volume24h / Math.min(ageInHours, 24);

        // Calculate score with emphasis on recent tokens
        const score = (
            (marketCapPerHour * 0.3) +
            (liquidityPerHour * 0.3) +
            (volumePerHour * 0.2) +
            ((48 - ageInHours) * 1000) // Bonus for newer tokens
        );

        console.log('\nToken Analysis:');
        console.log(`Name: ${token.name} (${token.symbol})`);
        console.log(`Address: ${token.address}`);
        console.log(`Age: ${ageInHours < 1 ? `${Math.round(ageInHours * 60)} minutes` : `${Math.round(ageInHours)} hours`}`);
        console.log(`Market Cap: $${tokenInfo.marketCap.toLocaleString()} ($${Math.round(marketCapPerHour).toLocaleString()}/hour)`);
        console.log(`Liquidity: $${tokenInfo.liquidity.toLocaleString()} ($${Math.round(liquidityPerHour).toLocaleString()}/hour)`);
        console.log(`24h Volume: $${tokenInfo.volume24h.toLocaleString()} ($${Math.round(volumePerHour).toLocaleString()}/hour)`);
        console.log(`Score: ${Math.round(score).toLocaleString()}`);
        if (token.description) {
            console.log(`Description: ${token.description}`);
        }

        tokenMetrics.push({
            token: {
                address: token.address,
                name: token.name,
                symbol: token.symbol,
                description: token.description
            },
            info: tokenInfo,
            ageInHours,
            score,
            marketCapPerHour,
            liquidityPerHour,
            volumePerHour
        });
    }

    if (tokenMetrics.length === 0) {
        console.log('No suitable tokens found');
        return null;
    }

    // Sort by score and get top 3
    const topTokens = tokenMetrics
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

    console.log('\n=== Top 3 Most Interesting Tokens ===');
    topTokens.forEach((item, index) => {
        const ageText = item.ageInHours < 1
            ? `${Math.round(item.ageInHours * 60)} minutes`
            : `${Math.round(item.ageInHours)} hours`;

        console.log(`\n${index + 1}. ${item.token.name} (${item.token.symbol})`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`• Age: ${ageText}`);
        console.log(`• Market Cap: $${item.info.marketCap.toLocaleString()} ($${Math.round(item.marketCapPerHour).toLocaleString()}/hour)`);
        console.log(`• Liquidity: $${item.info.liquidity.toLocaleString()} ($${Math.round(item.liquidityPerHour).toLocaleString()}/hour)`);
        console.log(`• Volume 24h: $${item.info.volume24h.toLocaleString()} ($${Math.round(item.volumePerHour).toLocaleString()}/hour)`);
        console.log(`• Created: ${new Date(item.info.createdAt).toLocaleString()}`);
        console.log(`• Address: ${item.token.address}`);
        if (item.token.description) {
            console.log(`• Description: ${item.token.description}`);
        }
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    });

    // Select the newest token from top 3
    const selectedToken = topTokens.reduce((newest, current) =>
        current.ageInHours < newest.ageInHours ? current : newest
    , topTokens[0]);

    if (selectedToken) {
        console.log('\n=== Selected Token for Purchase ===');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`Name: ${selectedToken.token.name} (${selectedToken.token.symbol})`);
        console.log(`Address: ${selectedToken.token.address}`);
        console.log(`Market Cap: $${selectedToken.info.marketCap.toLocaleString()}`);
        console.log(`Liquidity: $${selectedToken.info.liquidity.toLocaleString()}`);
        console.log(`24h Volume: $${selectedToken.info.volume24h.toLocaleString()}`);
        if (selectedToken.token.description) {
            console.log(`Description: ${selectedToken.token.description}`);
        }
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // Add token to purchased set and save
        purchasedTokens.add(selectedToken.token.address);
        savePurchasedTokens();

        // Save to file for trader.js
        const bestToken = {
            address: selectedToken.token.address,
            symbol: selectedToken.token.symbol,
            name: selectedToken.token.name,
            info: selectedToken.info
        };

        console.log('\nSaving selected token to file for trader...');
        fs.writeFileSync('selected_token.json', JSON.stringify(bestToken, null, 2));
        console.log('Token information saved successfully');
    }

    return selectedToken;
}

async function main() {
    try {
        while (true) {
            await findBestToken();
            console.log(`\nWaiting ${config.SCAN_INTERVAL_MINUTES} minutes before next scan...`);
            await new Promise(resolve => setTimeout(resolve, config.SCAN_INTERVAL_MINUTES * 60 * 1000));
        }
    } catch (error) {
        console.error('Error in main loop:', error.message);
    }
}

main();