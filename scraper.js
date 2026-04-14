const fs = require('fs');

// 从 GitHub Secrets 获取环境变量
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const NAMESPACE_ID = process.env.CF_NAMESPACE_ID;
const API_TOKEN = process.env.CF_API_TOKEN;

// 你想监控的地区列表 (可按需增删)
const REGIONS = ['cn', 'us', 'hk', 'jp', 'gb', 'tr']; 
const APPS = JSON.parse(fs.readFileSync('./apps.json', 'utf8'));

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scrapeApp(appId, regionCode) {
    // 1. 获取基础信息
    const searchUrl = `https://itunes.apple.com/${regionCode}/lookup?id=${appId}&limit=1`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    if (!searchData.results || searchData.results.length === 0) return null;
    const appBaseInfo = searchData.results[0];

    // 2. 获取网页 HTML
    const webUrl = `https://apps.apple.com/${regionCode}/app/id${appId}?l=en`;
    const htmlRes = await fetch(webUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9"
        }
    });
    if (!htmlRes.ok) return null;
    const htmlText = await htmlRes.text();

    // 3. 双保险解析逻辑
    const iaps = [];
    const nameTracker = {};

    // 策略 1：隐藏 JSON
    const jsonMatch = htmlText.match(/"inAppPurchases"\s*:\s*(\[\s*\{[\s\S]*?\}\s*\])/);
    if (jsonMatch) {
        try {
            JSON.parse(jsonMatch[1]).forEach(iap => {
                let name = iap.name || iap.title || 'Unknown';
                let priceStr = iap.priceFormatted || iap.formattedPrice || String(iap.price || 0);
                if (nameTracker[name]) { nameTracker[name]++; name = `${name} (${nameTracker[name]})`; } 
                else { nameTracker[name] = 1; }
                iaps.push({
                    wrapperType: "in-app-purchase", trackName: name, formattedPrice: priceStr,
                    price: parseFloat(priceStr.replace(/[^\d.,]/g, '').replace(',', '.')) || iap.price || 0,
                    currency: appBaseInfo.currency 
                });
            });
        } catch (e) {}
    }

    // 策略 2：暴力文本
    if (iaps.length === 0) {
        const blockMatch = htmlText.match(/(?:In-App Purchases|Top In-App Purchases|App 内购买项目)[\s\S]{0,1000}?(<ol[^>]*>[\s\S]*?<\/ol>|<ul[^>]*>[\s\S]*?<\/ul>)/i);
        if (blockMatch) {
            const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
            let liMatch;
            while ((liMatch = liRegex.exec(blockMatch[1])) !== null) {
                const texts = liMatch[1].replace(/<[^>]+>/g, '|').split('|').map(s => s.trim()).filter(s => s.length > 0 && !/^\d+\.?$/.test(s));
                if (texts.length >= 2) {
                    let name = texts[0];
                    let priceStr = texts[texts.length - 1];
                    if (nameTracker[name]) { nameTracker[name]++; name = `${name} (${nameTracker[name]})`; } 
                    else { nameTracker[name] = 1; }
                    iaps.push({
                        wrapperType: "in-app-purchase", trackName: name, formattedPrice: priceStr,
                        price: parseFloat(priceStr.replace(/[^\d.,]/g, '').replace(',', '.')) || 0,
                        currency: appBaseInfo.currency 
                    });
                }
            }
        }
    }

    return { resultCount: 1 + iaps.length, results: [appBaseInfo, ...iaps] };
}

async function writeToKV(key, value) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/${key}`;
    const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(value)
    });
    if (!res.ok) throw new Error(`写入失败: ${await res.text()}`);
}

async function main() {
    console.log(`开始抓取任务，共 ${APPS.length} 个 App...`);
    for (const appId of APPS) {
        for (const region of REGIONS) {
            try {
                const data = await scrapeApp(appId, region);
                if (data) {
                    await writeToKV(`${region}:${appId}`, data);
                    console.log(`✅ 成功抓取并写入 KV: ${region}区 - ${appId}`);
                } else {
                    console.log(`⚠️ 无数据或失败: ${region}区 - ${appId}`);
                }
            } catch (e) {
                console.error(`❌ 错误: ${region}区 - ${appId} - ${e.message}`);
            }
            await sleep(2000); // 暂停 2 秒，防止触发苹果或 CF 的频率限制
        }
    }
    console.log('🎉 所有任务执行完毕！');
}

main();
