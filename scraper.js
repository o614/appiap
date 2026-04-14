const fs = require('fs');

// 从 GitHub Secrets 获取环境变量
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const NAMESPACE_ID = process.env.CF_NAMESPACE_ID;
const API_TOKEN = process.env.CF_API_TOKEN;

// 监控的地区列表
const REGIONS = ['cn', 'us', 'hk', 'jp', 'gb', 'tr', 'ar', 'ng', 'ru']; 

// 兼容数组 ["123"] 和 对象 {"123": "Name"} 两种格式
const APPS_DATA = JSON.parse(fs.readFileSync('./apps.json', 'utf8'));
const APPS = Array.isArray(APPS_DATA) ? APPS_DATA : Object.keys(APPS_DATA);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 修复：智能解析带逗号和点的各种国家价格格式 (如 1.299,99 和 1,299.99)
function parsePrice(str) {
    if (!str) return 0;
    const cleanStr = str.replace(/[^\d.,]/g, ''); // 仅保留数字、点、逗号
    if (!cleanStr) return 0;
    
    const lastComma = cleanStr.lastIndexOf(',');
    const lastDot = cleanStr.lastIndexOf('.');
    
    if (lastComma > lastDot) {
        // 逗号是小数点 (例如欧洲、土耳其：1.299,99 -> 1299.99)
        return parseFloat(cleanStr.replace(/\./g, '').replace(',', '.'));
    } else {
        // 点是小数点 (例如中美英：1,299.99 -> 1299.99)
        return parseFloat(cleanStr.replace(/,/g, ''));
    }
}

async function scrapeApp(appId, regionCode) {
    try {
        // 1. 获取基础信息 (增加状态码校验)
        const searchUrl = `https://itunes.apple.com/${regionCode}/lookup?id=${appId}&limit=1`;
        const searchRes = await fetch(searchUrl);
        if (!searchRes.ok) throw new Error(`iTunes API 异常: ${searchRes.status}`);
        
        const searchData = await searchRes.json();
        if (!searchData.results || searchData.results.length === 0) return null;
        const appBaseInfo = searchData.results[0];

        // 2. 获取网页 HTML
        const webUrl = `https://apps.apple.com/${regionCode}/app/id${appId}?l=en`;
        const htmlRes = await fetch(webUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                "Accept-Language": "en-US,en;q=0.9"
            }
        });
        if (!htmlRes.ok) throw new Error(`HTML 抓取异常: ${htmlRes.status}`);
        const htmlText = await htmlRes.text();

        const iaps = [];
        const nameTracker = {};

        // 策略 1：隐藏 JSON 解析 (增加 try-catch 防止解析崩溃)
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
                        price: parsePrice(priceStr),
                        currency: appBaseInfo.currency 
                    });
                });
            } catch (e) { console.error(`JSON提取失败: ${e.message}`); }
        }

        // 策略 2：暴力文本 (扩大语言兼容范围)
        if (iaps.length === 0) {
            const blockMatch = htmlText.match(/(?:In-App Purchases|Top In-App Purchases|App 内购买项目|Uygulama İçi Satın Alımlar)[\s\S]{0,1000}?(<ol[^>]*>[\s\S]*?<\/ol>|<ul[^>]*>[\s\S]*?<\/ul>)/i);
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
                            price: parsePrice(priceStr),
                            currency: appBaseInfo.currency 
                        });
                    }
                }
            }
        }

        return { resultCount: 1 + iaps.length, results: [appBaseInfo, ...iaps] };
    } catch (error) {
        console.error(`抓取解析内部错误 [${regionCode}-${appId}]:`, error.message);
        return null;
    }
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
                if (data && data.results.length > 0) {
                    await writeToKV(`${region}:${appId}`, data);
                    console.log(`✅ 成功抓取并写入 KV: ${region}区 - ${appId}`);
                } else {
                    console.log(`⚠️ 未提取到内购数据或查询失败: ${region}区 - ${appId}`);
                }
            } catch (e) {
                console.error(`❌ 网络或外层错误: ${region}区 - ${appId} - ${e.message}`);
            }
            await sleep(2000); // 防封控
        }
    }
    console.log('🎉 所有任务执行完毕！');
}

main();
