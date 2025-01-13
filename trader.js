const { Connection, PublicKey, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram, VersionedTransaction, TransactionMessage } = require('@solana/web3.js');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');
const fs = require('fs');
const config = require('./config');
const wsClient = require('./websocket-client');

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

// Store active trading positions
let activeTokens = new Map();

// Add tracking file management
function saveActiveTokens() {
    const tokensData = Array.from(activeTokens.entries()).map(([address, data]) => ({
        address,
        name: data.name,
        symbol: data.symbol,
        initialPrice: data.initialPrice,
        initialLiquidity: data.initialLiquidity,
        purchaseTime: data.purchaseTime,
        purchaseAmount: data.purchaseAmount
    }));

    fs.writeFileSync('active_tokens.json', JSON.stringify(tokensData, null, 2));
    console.log('Active tokens saved');
}

function loadActiveTokens() {
    try {
        if (fs.existsSync('active_tokens.json')) {
            const data = fs.readFileSync('active_tokens.json', 'utf8');
            const tokensData = JSON.parse(data);
            activeTokens.clear();
            tokensData.forEach(token => {
                activeTokens.set(token.address, {
                    name: token.name,
                    symbol: token.symbol,
                    initialPrice: token.initialPrice,
                    initialLiquidity: token.initialLiquidity,
                    purchaseTime: token.purchaseTime,
                    purchaseAmount: token.purchaseAmount,
                    address: token.address
                });
            });
            console.log(`Loaded ${activeTokens.size} active tokens`);
        }
    } catch (error) {
        console.error('Error loading active tokens:', error.message);
    }
}

// Load active tokens at startup
loadActiveTokens();

let lastSuccessfulPriceApi = null;
let lastPriceCheck = 0;
let cachedSolPrice = null;

// Remove hardcoded RPC endpoints and use config
const RPC_ENDPOINTS = config.RPC_ENDPOINTS;

let currentRpcIndex = 0;

// Add token removal tracking
const tokenRemovalCandidates = new Map(); // Map to track tokens that might need to be removed
const tokenAccountCache = new Map(); // Cache to store token account data

// Add sold tokens tracking
const soldTokensWithPnL = new Map();

function saveSoldTokensWithPnL() {
    try {
        const soldTokensData = Array.from(soldTokensWithPnL.entries()).map(([address, data]) => ({
            address,
            symbol: data.symbol,
            name: data.name,
            profitLoss: data.profitLoss,
            soldAt: data.soldAt
        }));
        fs.writeFileSync('sold_positions.json', JSON.stringify(soldTokensData, null, 2));
        console.log('Saved sold positions data');
    } catch (error) {
        console.error('Error saving sold positions:', error);
    }
}

function loadSoldTokensWithPnL() {
    try {
        if (fs.existsSync('sold_positions.json')) {
            const data = fs.readFileSync('sold_positions.json', 'utf8');
            const tokens = JSON.parse(data);
            soldTokensWithPnL.clear();
            tokens.forEach(token => {
                soldTokensWithPnL.set(token.address, {
                    symbol: token.symbol,
                    name: token.name,
                    profitLoss: token.profitLoss,
                    soldAt: token.soldAt
                });
            });
            console.log(`Loaded ${soldTokensWithPnL.size} sold positions`);
        }
    } catch (error) {
        console.error('Error loading sold positions:', error);
    }
}

// Load sold positions at startup
loadSoldTokensWithPnL();

async function createConnection() {
    const currentEndpoint = RPC_ENDPOINTS[currentRpcIndex];
    // console.log(`Creating connection using RPC endpoint [${currentRpcIndex + 1}/${RPC_ENDPOINTS.length}]: ${currentEndpoint}`);

    const options = {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 1000,
        wsEndpoint: currentEndpoint.startsWith('https://') ?
            currentEndpoint.replace('https://', 'wss://') :
            undefined
    };

    return new Connection(currentEndpoint, options);
}

async function getWorkingConnection() {
    let connection;
    let attempts = 0;
    const maxAttempts = RPC_ENDPOINTS.length * 2; // Try each endpoint twice

    while (attempts < maxAttempts) {
        try {
            connection = await createConnection();
            // Test the connection
            await connection.getSlot();
            console.log(`Successfully connected to RPC [${currentRpcIndex + 1}/${RPC_ENDPOINTS.length}]: ${RPC_ENDPOINTS[currentRpcIndex]}`);
            return connection;
        } catch (error) {
            // console.error(`RPC connection failed [${currentRpcIndex + 1}/${RPC_ENDPOINTS.length}] (${RPC_ENDPOINTS[currentRpcIndex]}):`, error.message);
            // Switch to next RPC endpoint
            currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
            attempts++;

            if (attempts < maxAttempts) {
                // console.log(`Switching to next RPC endpoint [${currentRpcIndex + 1}/${RPC_ENDPOINTS.length}]: ${RPC_ENDPOINTS[currentRpcIndex]}`);
            }
        }
    }
    throw new Error('All RPC endpoints failed');
}

async function withRpcRetry(operation) {
    let attempts = 0;
    const maxAttempts = RPC_ENDPOINTS.length * 2;

    while (attempts < maxAttempts) {
        try {
            return await operation();
        } catch (error) {
            if (error.message.includes('429') || error.message.includes('Too many requests')) {
                // console.log(`RPC rate limit hit [${currentRpcIndex + 1}/${RPC_ENDPOINTS.length}] (${RPC_ENDPOINTS[currentRpcIndex]}), switching endpoint...`);
                currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
                console.log(`Switched to RPC [${currentRpcIndex + 1}/${RPC_ENDPOINTS.length}]: ${RPC_ENDPOINTS[currentRpcIndex]}`);
                const connection = await createConnection();
                attempts++;

                if (attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
            }
            throw error;
        }
    }
    throw new Error('Operation failed after all RPC retries');
}

async function getTokenMetadata(mintAddress) {
    try {
        const response = await fetch(`https://tokens.jup.ag/token/${mintAddress}`);
        const token = await response.json();

        if (token) {
            return {
                name: token.name,
                symbol: token.symbol,
                decimals: token.decimals,
                tags: token.tags,
                dailyVolume: token.daily_volume
            };
        }
        return null;
    } catch (error) {
        console.error('Error fetching token metadata:', error.message);
        return null;
    }
}

async function getTokenDecimals(connection, mintAddress) {
    try {
        const info = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
        return info.value?.data?.parsed?.info?.decimals ?? null;
    } catch (error) {
        console.error('Error fetching token decimals:', error.message);
        return null;
    }
}

async function getSolPrice() {
    const CACHE_DURATION = 60000; // 1 minute cache
    const currentTime = Date.now();

    // Return cached price if available and not expired
    if (cachedSolPrice && lastPriceCheck && (currentTime - lastPriceCheck < CACHE_DURATION)) {
        return cachedSolPrice;
    }

    const APIs = [
        {
            name: 'CoinGecko',
            url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
            handler: (data) => data?.solana?.usd
        },
        {
            name: 'Jupiter',
            url: 'https://price.jup.ag/v4/price?ids=SOL',
            handler: (data) => data?.data?.SOL?.price
        },
        {
            name: 'Birdeye',
            url: 'https://public-api.birdeye.so/public/price?address=So11111111111111111111111111111111111111112',
            handler: (data) => data?.data?.value
        }
    ];

    // Try last successful API first
    if (lastSuccessfulPriceApi) {
        try {
            const response = await fetch(lastSuccessfulPriceApi.url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0'
                }
            });

            if (response.ok) {
                const data = await response.json();
                const price = lastSuccessfulPriceApi.handler(data);

                if (price && !isNaN(price) && price > 0) {
                    // console.log(`Got SOL price from ${lastSuccessfulPriceApi.name}: $${price}`);
                    cachedSolPrice = price;
                    lastPriceCheck = currentTime;
                    return price;
                }
            }
        } catch (error) {
            // console.log(`Previous successful API (${lastSuccessfulPriceApi.name}) failed, trying others...`);
        }
    }

    // Try other APIs
    for (const api of APIs) {
        // Skip if this was the last successful API we just tried
        if (lastSuccessfulPriceApi && api.name === lastSuccessfulPriceApi.name) {
            continue;
        }

        try {
            const response = await fetch(api.url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0'
                },
                timeout: 5000 // 5 second timeout
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            const price = api.handler(data);

            if (price && !isNaN(price) && price > 0) {
                // console.log(`Got SOL price from ${api.name}: $${price}`);
                lastSuccessfulPriceApi = api;
                cachedSolPrice = price;
                lastPriceCheck = currentTime;
                return price;
            }
        } catch (error) {
            console.log(`${api.name} API failed: ${error.message}`);
        }
    }

    // If we have a cached price, use it even if expired
    if (cachedSolPrice) {
        console.log(`Using last known price: $${cachedSolPrice}`);
        return cachedSolPrice;
    }

    // Last resort: use default price
    console.log('All price APIs failed and no cached price available, using default price');
    return 20;
}

async function getDexScreenerInfo(tokenAddress) {
    try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        const data = await response.json();
        if (data.pairs && data.pairs.length > 0) {
            // only get tokens coming from pumpfun
            const isPumpFun = data.pairs.find(pair => pair.dexId === 'pumpfun');
            if(!isPumpFun) {
                console.log('[Trader] Token NOT from PUMPFUN skipping...');
                return null;
            }
            console.log('[Trader] Token is from PUMPFUN returning info');

            const mainPair = data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
            return {
                marketCap: mainPair.marketCap || 0,
                priceUsd: parseFloat(mainPair.priceUsd) || 0,
                liquidity: mainPair.liquidity?.usd || 0,
                volume24h: mainPair.volume?.h24 || 0,
                priceChange24h: mainPair.priceChange?.h24 || 0,
                createdAt: mainPair.createdAt,
                dexId: mainPair.dexId
            };
        }
        return null;
    } catch (error) {
        console.error('Error fetching DexScreener info:', error.message);
        return null;
    }
}

async function checkTransactionStatus(connection, signature) {
    let retries = 30;
    while (retries > 0) {
        try {
            const status = await connection.getSignatureStatus(signature);
            if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
                return true;
            }
        } catch (error) {
            console.error('Error checking transaction status:', error.message);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        retries--;
    }
    return false;
}

async function customSendAndConfirmTransaction(connection, transaction, wallet, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            // Get latest blockhash
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

            // Sign the transaction
            transaction.sign([wallet]);

            // Send raw transaction
            const rawTransaction = transaction.serialize();
            const txid = await connection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
                maxRetries: 2
            });

            // console.log(`Transaction sent via RPC [${currentRpcIndex + 1}/${RPC_ENDPOINTS.length}]: ${RPC_ENDPOINTS[currentRpcIndex]}`);
            // console.log(`Signature: ${txid}`);
            // console.log(`View in Explorer: https://solscan.io/tx/${txid}`);

            // Start async confirmation check
            checkTransactionConfirmation(connection, txid, blockhash, lastValidBlockHeight);

            // Return signature immediately
            return txid;
        } catch (error) {
            console.error(`Transaction attempt ${i + 1} failed:`, error.message);
            if (i < retries - 1) {
                currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
                // console.log(`Switching to RPC [${currentRpcIndex + 1}/${RPC_ENDPOINTS.length}]: ${RPC_ENDPOINTS[currentRpcIndex]}`);
                connection = await createConnection();
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    }
    throw new Error('Transaction failed after all retries');
}

async function checkTransactionConfirmation(connection, signature, blockhash, lastValidBlockHeight) {
    try {
        const confirmation = await connection.confirmTransaction({
            signature: signature,
            blockhash: blockhash,
            lastValidBlockHeight: lastValidBlockHeight
        }, 'confirmed');

        if (confirmation?.value?.err) {
            console.error(`Transaction failed: ${confirmation.value.err}`);
        } else {
            console.log(`Transaction confirmed: ${signature}`);
        }
    } catch (error) {
        console.error('Error confirming transaction:', error.message);
    }
}

async function buyToken(connection, wallet, token) {
    try {
        // Check if we already have this token
        if (activeTokens.has(token.address)) {
            console.log(`Token ${token.symbol} is already in active positions`);
            fs.unlinkSync('selected_token.json');
            return false;
        }

        // Delete selected_token.json before attempting purchase to prevent double buys
        if (fs.existsSync('selected_token.json')) {
            fs.unlinkSync('selected_token.json');
        }

        console.log(`\n=== Buying ${token.name} (${token.symbol}) ===`);
        // console.log(`• Address: ${token.address}`);
        // console.log(`• Price: $${token.info.priceUsd}`);
        // console.log(`• Liquidity: $${token.info.liquidity.toLocaleString()}`);

        const inputMint = "So11111111111111111111111111111111111111112"; // SOL
        const outputMint = token.address;

        // Validate token address
        try {
            new PublicKey(outputMint);
        } catch (error) {
            console.error('Invalid token address');
            return false;
        }

        // Validate token liquidity and market data
        const tokenInfo = await getDexScreenerInfo(outputMint);
        if (!tokenInfo) {
            console.error('Could not fetch token market data');
            return false;
        }

        // Basic validation checks
        if (!tokenInfo.liquidity || tokenInfo.liquidity < 1000) {
            console.error('Token has insufficient liquidity');
            return false;
        }

        // Get token metadata to verify symbol and name
        const metadata = await getTokenMetadata(outputMint);
        if (metadata) {
            console.log('Token metadata from Jupiter:', metadata);
            // Verify token metadata matches
            if (metadata.symbol && metadata.symbol.toLowerCase() !== token.symbol.toLowerCase()) {
                console.error(`Token symbol mismatch. Expected: ${token.symbol}, Got: ${metadata.symbol}`);
                return false;
            }
        }

        console.log(`\nInitiating purchase of ${token.name} (${token.symbol})...`);
        console.log('Token details:');
        console.log(`- Address: ${outputMint}`);
        console.log(`- Symbol: ${token.symbol}`);
        console.log(`- Name: ${token.name}`);
        console.log(`- Liquidity: $${tokenInfo.liquidity.toLocaleString()}`);

        // 1. Get quote from Jupiter with proper URL encoding
        const quoteUrl = new URL('https://quote-api.jup.ag/v6/quote');
        quoteUrl.searchParams.append('inputMint', inputMint);
        quoteUrl.searchParams.append('outputMint', outputMint);
        quoteUrl.searchParams.append('amount', Math.floor(config.AMOUNT_TO_SPEND * 1e9).toString());
        quoteUrl.searchParams.append('slippageBps', config.SLIPPAGE_BPS.toString());
        quoteUrl.searchParams.append('onlyDirectRoutes', 'false');
        quoteUrl.searchParams.append('asLegacyTransaction', 'false');

        console.log('Requesting quote with URL:', quoteUrl.toString());

        const quoteResponse = await fetch(quoteUrl.toString(), {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });

        if (!quoteResponse.ok) {
            const errorText = await quoteResponse.text();
            console.error('Quote API Error Response:', errorText);
            try {
                const errorJson = JSON.parse(errorText);
                console.error('Quote API Error Details:', errorJson);
            } catch (e) {
                console.error('Could not parse error response as JSON');
            }
            throw new Error(`HTTP error! status: ${quoteResponse.status} - ${errorText}`);
        }

        const quoteData = await quoteResponse.json();
        // console.log('Jupiter API response:', JSON.stringify(quoteData, null, 2));

        // Verify the output token in the route matches our intended token
        if (quoteData.routePlan && quoteData.routePlan.length > 0) {
            const lastRoute = quoteData.routePlan[quoteData.routePlan.length - 1];
            if (lastRoute.swapInfo.outputMint !== outputMint) {
                console.error(`Route output mint mismatch. Expected: ${outputMint}, Got: ${lastRoute.swapInfo.outputMint}`);
                return false;
            }
        }

        // Check if we have a valid route plan
        if (!quoteData || !quoteData.routePlan || quoteData.routePlan.length === 0) {
            throw new Error('No valid route plan received');
        }

        // 2. Get serialized transaction
        const swapRequestBody = {
            quoteResponse: quoteData,
            userPublicKey: wallet.publicKey.toString(),
            wrapUnwrapSOL: true,
            prioritizationFeeLamports: config.PRIORITY_FEE_SOL * 1e9,
            asLegacyTransaction: false,
            useVersionedTransaction: true,
            dynamicComputeUnitLimit: true
        };

        // console.log('Swap request body:', JSON.stringify(swapRequestBody, null, 2));

        const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(swapRequestBody)
        });

        if (!swapResponse.ok) {
            const errorText = await swapResponse.text();
            // console.error('Swap API Error Response:', errorText);
            try {
                const errorJson = JSON.parse(errorText);
                // console.error('Swap API Error Details:', errorJson);
            } catch (e) {
                // console.error('Could not parse error response as JSON');
            }
            throw new Error(`Swap API error: ${swapResponse.status} - ${errorText}`);
        }

        const swapData = await swapResponse.json();
        // console.log('Swap API response:', JSON.stringify(swapData, null, 2));

        if (!swapData.swapTransaction) {
            throw new Error('No swap transaction received');
        }

        // 3. Deserialize and send the transaction
        const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

        // 4. Execute the transaction
        console.log('Sending buy transaction...');
        const signature = await customSendAndConfirmTransaction(connection, transaction, wallet);

        // Start checking token balance immediately
        let retries = 0;
        const maxRetries = 10;
        const checkInterval = 3000; // 3 seconds

        async function checkPurchase() {
            try {
                const tokenAccount = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
                    mint: new PublicKey(outputMint)
                });

                const tokenBalance = tokenAccount.value.length > 0
                    ? tokenAccount.value[0].account.data.parsed.info.tokenAmount.uiAmount
                    : 0;

                if (tokenBalance > 0) {
                    console.log('Purchase successful!\n');

                    // Add purchase time and amount to token data
                    activeTokens.set(token.address, {
                        name: token.name || 'Unknown',
                        symbol: token.symbol || 'Unknown',
                        initialPrice: token.info.priceUsd,
                        initialLiquidity: token.info.liquidity,
                        address: token.address,
                        purchaseTime: new Date().toISOString(),
                        purchaseAmount: tokenBalance
                    });

                    // Save to file immediately after purchase
                    saveActiveTokens();

                    console.log('Token added to active positions:', token.symbol);
                    const solPrice = await getSolPrice();
                    const updatedPositionsInfo = await getAllPositionsInfo(connection, wallet, solPrice);
                    wsClient.updateMonitoringInfo(updatedPositionsInfo);
        return true;
                }

                if (retries < maxRetries) {
                    retries++;
                    setTimeout(checkPurchase, checkInterval);
                } else {
                    console.error('Purchase verification failed: No token balance found after maximum retries');
                    return false;
                }
    } catch (error) {
                console.error('Error checking purchase:', error.message);
        return false;
    }
}

        // Start checking purchase status
        checkPurchase();
        return true;

            } catch (error) {
        console.error('Error buying token:', error.message);
        return false;
    }
}

async function executeSell(connection, wallet, tokenAddress, tokenData, isTriggerSell = false) {
    try {
        console.log(`\nExecuting sell order...`);

        // Get current token balance
        const tokenAccount = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
            mint: new PublicKey(tokenAddress)
        });

        if (!tokenAccount.value.length) {
            console.error('No token account found for this token');
            return false;
        }

        const tokenBalance = tokenAccount.value[0].account.data.parsed.info.tokenAmount.amount;
        if (!tokenBalance || tokenBalance === '0') {
            console.error('Token balance is zero');
            return false;
        }

        // Get current token info for P&L calculation
        const tokenInfo = await getDexScreenerInfo(tokenAddress);
        if (!tokenInfo) {
            console.error('Could not get token info for P&L calculation');
            return false;
        }

        // Calculate P&L before executing sell
        const profitLoss = ((tokenInfo.priceUsd - tokenData.initialPrice) / tokenData.initialPrice) * 100;

        // Get quote from Jupiter
        const quoteResponse = await fetch('https://quote-api.jup.ag/v6/quote?' + new URLSearchParams({
            inputMint: tokenAddress,
            outputMint: "So11111111111111111111111111111111111111112", // SOL
            amount: tokenBalance,
            slippageBps: config.SELL_SLIPPAGE_BPS
        }));

        const quoteData = await quoteResponse.json();

        // Validate output amount (minimum 0.00001 SOL = 10000 lamports)
        const minimumOutputAmount = 10000;
        if (!quoteData.outAmount || parseInt(quoteData.outAmount) < minimumOutputAmount) {
            console.error(`Output amount (${quoteData.outAmount} lamports) is too low to execute sell`);
            return false;
        }

        // 2. Get serialized transaction
        const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                quoteResponse: quoteData,
                userPublicKey: wallet.publicKey.toString(),
                wrapUnwrapSOL: true,
                prioritizationFeeLamports: 'auto',
                dynamicComputeUnitLimit: true
            })
        });

        if (!swapResponse.ok) {
            throw new Error(`HTTP error! status: ${swapResponse.status}`);
        }

        const swapData = await swapResponse.json();

        if (!swapData.swapTransaction) {
            throw new Error('No swap transaction received');
        }

        // 3. Deserialize and send the transaction
        const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

        // 4. Execute the transaction
        console.log('Sending sell transaction...');
        const signature = await customSendAndConfirmTransaction(connection, transaction, wallet);

        // After successful sell, save the P&L information
        if (isTriggerSell || await checkSaleSuccess(connection, wallet, tokenAddress)) {
            console.log(`Sale successful! P&L: ${profitLoss.toFixed(2)}%`);

            // Add to sold positions with P&L info
            soldTokensWithPnL.set(tokenAddress, {
                symbol: tokenData.symbol,
                name: tokenData.name,
                profitLoss: profitLoss,
                soldAt: new Date().toISOString()
            });

            // Save to file immediately
            saveSoldTokensWithPnL();

            // Remove from active tokens and tracking
            activeTokens.delete(tokenAddress);
            tokenRemovalCandidates.delete(tokenAddress);
            await saveActiveTokens();

            // Update monitoring info immediately
            const solPrice = await getSolPrice();
            const updatedPositionsInfo = await getAllPositionsInfo(connection, wallet, solPrice);
            wsClient.updateMonitoringInfo(updatedPositionsInfo);

            return true;
        }

        return false;
    } catch (error) {
        console.error('Error executing sell:', error.message);
        return false;
    }
}

async function getAllPositionsInfo(connection, wallet, solPrice) {
    const positions = [];
    const walletBalance = await connection.getBalance(wallet.publicKey);
    const walletBalanceSOL = walletBalance / 1e9;
    const walletBalanceUSD = walletBalanceSOL * solPrice;

    console.log(`Active tokens: ${activeTokens.size}`);

    // Create a Map to track which tokens we've processed
    const processedTokens = new Map();

    // First, check all tokens in the wallet
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    });

    console.log(`Found ${tokenAccounts.value.length} token accounts in wallet`);

    // Process all tokens in wallet
    for (const account of tokenAccounts.value) {
        const tokenAddress = account.account.data.parsed.info.mint;
        const balance = account.account.data.parsed.info.tokenAmount.uiAmount;

        // Skip if token was sold before
        if (soldTokensWithPnL.has(tokenAddress)) {
            continue;
        }

        if (balance > 0) {
            // Remove from removal candidates if token is found with balance
            if (tokenRemovalCandidates.has(tokenAddress)) {
                tokenRemovalCandidates.delete(tokenAddress);
            }

            // Process token as before...
            if (activeTokens.has(tokenAddress)) {
                const tokenData = activeTokens.get(tokenAddress);
                const tokenInfo = await getDexScreenerInfo(tokenAddress);

                if (tokenInfo) {
        const priceChange = ((tokenInfo.priceUsd - tokenData.initialPrice) / tokenData.initialPrice) * 100;
                    const positionValue = balance * tokenInfo.priceUsd;

        positions.push({
            symbol: tokenData.symbol,
            name: tokenData.name,
            marketCap: tokenInfo.marketCap,
            priceUsd: tokenInfo.priceUsd,
            priceChange: priceChange,
                        balance: balance,
                        positionValue: positionValue,
                        purchaseTime: tokenData.purchaseTime
                    });

                    processedTokens.set(tokenAddress, true);
                }
            } else {
                // Handle new tokens as before...
                try {
                    const tokenInfo = await getDexScreenerInfo(tokenAddress);
                    const metadata = await getTokenMetadata(tokenAddress);

                    if (tokenInfo && metadata) {
                        activeTokens.set(tokenAddress, {
                            name: metadata.name,
                            symbol: metadata.symbol,
                            initialPrice: tokenInfo.priceUsd,
                            initialLiquidity: tokenInfo.liquidity,
                            address: tokenAddress,
                            purchaseTime: new Date().toISOString(),
                            purchaseAmount: balance
                        });

                        positions.push({
                            symbol: metadata.symbol,
                            name: metadata.name,
                            marketCap: tokenInfo.marketCap,
                            priceUsd: tokenInfo.priceUsd,
                            priceChange: 0,
                            balance: balance,
                            positionValue: balance * tokenInfo.priceUsd
                        });

                        processedTokens.set(tokenAddress, true);
                        saveActiveTokens();
                    }
                } catch (error) {
                    console.error(`Error processing unknown token ${tokenAddress}:`, error.message);
                }
            }
        }
    }

    // Handle tokens not found in wallet
    for (const [address, tokenData] of activeTokens) {
        if (!processedTokens.has(address)) {
            // If token is not in removal candidates, add it with timestamp
            if (!tokenRemovalCandidates.has(address)) {
                tokenRemovalCandidates.set(address, {
                    timestamp: Date.now(),
                    data: tokenData
                });
            } else {
                // Check if token has been missing for more than 30 seconds
                const removalData = tokenRemovalCandidates.get(address);
                if (Date.now() - removalData.timestamp > 30000) { // 30 seconds
                    console.log(`Removing ${tokenData.symbol} from active tokens - not found in wallet for 30 seconds`);
                    activeTokens.delete(address);
                    tokenRemovalCandidates.delete(address);
                    saveActiveTokens();
                } else {
                    // Still include the token in positions while waiting
                    const tokenInfo = await getDexScreenerInfo(address);
                    if (tokenInfo) {
                        const priceChange = ((tokenInfo.priceUsd - tokenData.initialPrice) / tokenData.initialPrice) * 100;
                        positions.push({
                            symbol: tokenData.symbol,
                            name: tokenData.name,
                            marketCap: tokenInfo.marketCap,
                            priceUsd: tokenInfo.priceUsd,
                            priceChange: priceChange,
                            balance: tokenData.purchaseAmount,
                            positionValue: tokenData.purchaseAmount * tokenInfo.priceUsd,
                            purchaseTime: tokenData.purchaseTime
                        });
                    }
                }
            }
        }
    }

    // Load and add sold positions to the result
    let soldPositions = [];
    try {
        if (fs.existsSync('sold_positions.json')) {
            const soldData = fs.readFileSync('sold_positions.json', 'utf8');
            const soldTokens = JSON.parse(soldData);
            soldPositions = soldTokens.map(token => ({
                symbol: token.symbol,
                profitLoss: token.profitLoss
            })).sort((a, b) => new Date(b.soldAt) - new Date(a.soldAt));

            console.log(`Loaded ${soldPositions.length} sold positions from file`);
        }
    } catch (error) {
        console.error('Error loading sold positions:', error);
    }

    const result = {
        positions,
        soldPositions,
        walletBalanceSOL,
        walletBalanceUSD,
        lastUpdateTime: new Date().toLocaleTimeString()
    };

    return result;
}

async function monitorPositions(connection, wallet) {
    while (true) {
        try {
            // Check for new tokens to buy
            if (fs.existsSync('selected_token.json')) {
                const data = fs.readFileSync('selected_token.json', 'utf8');
                let selectedToken;

                try {
                    selectedToken = JSON.parse(data);
                } catch (error) {
                    fs.unlinkSync('selected_token.json');
                    continue;
                }

                if (!selectedToken.address || !selectedToken.name || !selectedToken.symbol) {
                    fs.unlinkSync('selected_token.json');
                    continue;
                }

                if (activeTokens.has(selectedToken.address)) {
                    fs.unlinkSync('selected_token.json');
                    continue;
                }

                const tokenInfo = await getDexScreenerInfo(selectedToken.address);
                if (!tokenInfo || !tokenInfo.liquidity || tokenInfo.liquidity < 1000 || !tokenInfo.priceUsd || tokenInfo.priceUsd <= 0) {
                    fs.unlinkSync('selected_token.json');
                    continue;
                }

                const tokenData = {
                    address: selectedToken.address,
                    name: selectedToken.name || 'Unknown',
                    symbol: selectedToken.symbol || 'Unknown',
                    info: tokenInfo
                };

                const success = await buyToken(connection, wallet, tokenData);
                if (success) {
                    activeTokens.set(selectedToken.address, {
                        name: selectedToken.name || 'Unknown',
                        symbol: selectedToken.symbol || 'Unknown',
                        initialPrice: tokenInfo.priceUsd,
                        initialLiquidity: tokenInfo.liquidity,
                        address: selectedToken.address
                    });

                    console.log('Token added to active positions:', selectedToken.symbol);
                    const solPrice = await getSolPrice();
                    const updatedPositionsInfo = await getAllPositionsInfo(connection, wallet, solPrice);
                    wsClient.updateMonitoringInfo(updatedPositionsInfo);
                    fs.unlinkSync('selected_token.json');
                }
            }

            // Update positions every 10 seconds
            const solPrice = await getSolPrice();
            const allPositionsInfo = await getAllPositionsInfo(connection, wallet, solPrice);
            wsClient.updateMonitoringInfo(allPositionsInfo);

            // Check for sell conditions
            for (const [address, tokenData] of activeTokens) {
                const position = allPositionsInfo.positions.find(p => p.symbol === tokenData.symbol);
                if (!position) continue;

                const tokenInfo = await getDexScreenerInfo(address);
                if (tokenInfo) {

                    if (tokenInfo.liquidity <= 100) {
                        console.log('Token Rugged skipping sell: ', tokenData.symbol);
                        continue;
                    }

                    const liquidityDropPercentage = ((tokenData.initialLiquidity - tokenInfo.liquidity) / tokenData.initialLiquidity) * 100;
                    if (liquidityDropPercentage > 50) {
                        console.log(`\n=== Emergency Sell: ${tokenData.symbol} ===`);
                        console.log(`• Liquidity drop: ${liquidityDropPercentage.toFixed(2)}%`);
                        const success = await executeSell(connection, wallet, address, tokenData, true);
                        if (success) {
                            wsClient.updateMonitoringInfo(await getAllPositionsInfo(connection, wallet, solPrice));
                        }
                        continue;
                    }
                }

                if (position.priceChange <= -config.STOP_LOSS_PERCENTAGE ||
                    position.priceChange >= config.TAKE_PROFIT_PERCENTAGE) {
                    console.log(`\n=== Selling ${tokenData.symbol} ===`);
                    console.log(`• Price change: ${position.priceChange.toFixed(2)}%`);
                    const success = await executeSell(connection, wallet, address, tokenData, true);
                    if (success) {
                        wsClient.updateMonitoringInfo(await getAllPositionsInfo(connection, wallet, solPrice));
                    }
                }
            }

            // Wait 10 seconds before next update
            await new Promise(resolve => setTimeout(resolve, 10000));
        } catch (error) {
            console.error('Error in monitoring loop:', error.message);
            currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
            connection = await createConnection();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

async function getTokenBalance(connection, tokenMint, owner) {
    try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
            mint: new PublicKey(tokenMint)
        });

        if (tokenAccounts.value.length > 0) {
            const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
            return balance > 0 ? balance : 0;
        }
        return 0;
    } catch (error) {
        console.error(`Error getting token balance for ${tokenMint}:`, error);
        return 0;
    }
}

async function verifyTokensInWallet() {
    try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
            programId: TOKEN_PROGRAM_ID
        });

        console.log(`Found ${tokenAccounts.value.length} token accounts in wallet`);

        // Update token account cache
        tokenAccountCache.clear();
        for (const { account, pubkey } of tokenAccounts.value) {
            const { mint, tokenAmount } = account.data.parsed.info;
            if (tokenAmount.uiAmount > 0) {
                tokenAccountCache.set(mint, {
                    balance: tokenAmount.uiAmount,
                    lastSeen: Date.now(),
                    accountPubkey: pubkey
                });
            }
        }

        // Check active tokens against cache
        for (const [tokenAddress, tokenData] of activeTokens.entries()) {
            const cachedData = tokenAccountCache.get(tokenAddress);

            if (!cachedData) {
                // Only mark for removal if we haven't seen the token for more than 2 minutes
                if (!tokenData.lastSeen || Date.now() - tokenData.lastSeen > 120000) {
                    if (!tokenData.isBeingRemoved) {
                        console.log(`Token ${tokenData.symbol} (${tokenAddress}) not found in wallet for 2 minutes - marking for removal`);
                        tokenData.isBeingRemoved = true;
                        tokenData.removalStartTime = Date.now();
                    } else if (Date.now() - tokenData.removalStartTime > 30000) {
                        console.log(`Removing ${tokenData.symbol} from active tokens - confirmed absence`);
                        activeTokens.delete(tokenAddress);
                        await saveActiveTokens();
                    }
                }
            } else {
                // Token is present, update its data
                tokenData.lastSeen = Date.now();
                tokenData.isBeingRemoved = false;
                tokenData.removalStartTime = null;
                tokenData.balance = cachedData.balance;
            }
        }

        // Add new tokens found in wallet but not in activeTokens
        for (const [mint, data] of tokenAccountCache.entries()) {
            if (!activeTokens.has(mint) && data.balance > 0) {
                try {
                    const tokenInfo = await getTokenMetadata(mint);
                    if (tokenInfo) {
                        activeTokens.set(mint, {
                            address: mint,
                            symbol: tokenInfo.symbol,
                            name: tokenInfo.name,
                            balance: data.balance,
                            lastSeen: Date.now()
                        });
                        console.log(`Added new token to active tokens: ${tokenInfo.symbol} (${mint})`);
                        await saveActiveTokens();
                    }
                } catch (error) {
                    console.error(`Error getting metadata for token ${mint}:`, error);
                }
            }
        }

    } catch (error) {
        console.error('Error verifying tokens in wallet:', error);
    }
}

// Update the monitoring loop
async function startMonitoring() {
    while (true) {
        try {
            await verifyTokensInWallet();

            // Get positions info and send update
            const positionsInfo = await getAllPositionsInfo();
            if (wsClient) {
                wsClient.updateMonitoringInfo(positionsInfo);
            }

        } catch (error) {
            console.error('Error in monitoring loop:', error);
        }

        await new Promise(resolve => setTimeout(resolve, 10000));
    }
}

async function main() {
    try {
        let connection = await getWorkingConnection();
        let privateKeyArray;
        try {
            privateKeyArray = JSON.parse(config.PRIVATE_KEY);
        } catch {
            privateKeyArray = Array.from(bs58.decode(config.PRIVATE_KEY));
        }
        const wallet = Keypair.fromSecretKey(new Uint8Array(privateKeyArray));

        console.log('Starting trader...');
        console.log(`Wallet address: ${wallet.publicKey.toString()}`);

        // Wrap the monitoring function with RPC retry logic
        while (true) {
            try {
                await withRpcRetry(() => monitorPositions(connection, wallet));
            } catch (error) {
                console.error('Error in monitoring loop, attempting to reconnect:', error.message);
                connection = await getWorkingConnection();
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    } catch (error) {
        console.error('Error in main:', error.message);
    }
}

// Update other functions to use withRpcRetry
const originalGetTokenMetadata = getTokenMetadata;
getTokenMetadata = async function(mintAddress) {
    return withRpcRetry(() => originalGetTokenMetadata(mintAddress));
};

const originalGetTokenDecimals = getTokenDecimals;
getTokenDecimals = async function(connection, mintAddress) {
    return withRpcRetry(() => originalGetTokenDecimals(connection, mintAddress));
};

const originalGetSolPrice = getSolPrice;
getSolPrice = async function() {
    return withRpcRetry(() => originalGetSolPrice());
};

const originalGetDexScreenerInfo = getDexScreenerInfo;
getDexScreenerInfo = async function(tokenAddress) {
    return withRpcRetry(() => originalGetDexScreenerInfo(tokenAddress));
};

main();