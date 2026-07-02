import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { 
        keyword = 'accounting firm', 
        location = '', 
        maxLeads = 100,
        proxyConfiguration 
    } = input || {};

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { 
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'SG'
    });

    const displayLocation = location ? ` in "${location}"` : ' in Singapore';
    log.info(`Searching Singapore financial directories for "${keyword}"${displayLocation}`);
    
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let extractedCount = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 2,
        navigationTimeoutSecs: 90,
        browserPoolOptions: {
            useFingerprints: true,
        },
        async requestHandler({ page, request, log, enqueueLinks }) {
            log.info(`Parsing directory page: ${request.url}`);
            
            await page.waitForSelector('.listing-card, .company-box, .result-item, .business-card, .list-item, .search-result', { timeout: 30000 }).catch(() => log.warning('Timeout waiting for DOM.'));

            const title = await page.title();
            if (title.includes('Just a moment') || title.includes('Access Denied')) {
                throw new Error('Blocked by WAF. Retrying with residential proxy...');
            }

            // Scroll down a bit to trigger lazy loading
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
            await page.waitForTimeout(2000);

            const items = await page.$$('.listing-card, .company-box, .result-item, .business-card, .list-item, .search-result');
            
            for (const item of items) {
                if (extractedCount >= maxLeads) break;

                const nameElement = await item.$('h2, h3, .company-name, .title, .biz-name');
                if (!nameElement) continue;
                const firmName = (await nameElement.innerText()).trim();

                const addressElement = await item.$('.address, .location, .comp-loc, .biz-address, .address-text');
                const address = addressElement ? (await addressElement.innerText()).trim().replace(/\s+/g, ' ') : '';

                // Category or Services
                const catElement = await item.$('.category, .industry, .cat-link');
                const services = catElement ? (await catElement.innerText()).trim() : keyword;

                // Phones
                const phoneElement = await item.$('a[href^="tel:"], .phone, .contact-number, .call-btn, .mobile');
                let phone = '';
                if (phoneElement) {
                    const href = await phoneElement.getAttribute('href');
                    if (href && href.startsWith('tel:')) {
                        phone = href.replace('tel:', '').trim();
                    } else {
                        phone = (await phoneElement.innerText()).trim();
                    }
                }
                
                // Website
                const websiteElement = await item.$('.website a, a[title*="Website"], a.co-web, .weblink a');
                const website = websiteElement ? await websiteElement.getAttribute('href') : '';
                
                // URL
                const urlElement = await item.$('h2 a, h3 a, .company-name a, .biz-name a, .title a');
                const listingUrl = urlElement ? await urlElement.getAttribute('href') : '';
                const fullListingUrl = listingUrl && !listingUrl.startsWith('http') ? new URL(listingUrl, 'https://www.yellowpages.com.sg').toString() : listingUrl;

                if (firmName && firmName.length > 1) {
                    const record = {
                        firmName,
                        services,
                        address,
                        phone,
                        website,
                        listingUrl: fullListingUrl,
                        scrapedAt: new Date().toISOString()
                    };

                    await Actor.pushData(record);
                    await Actor.charge({ eventName: 'lead-extracted', count: 1 });
                    extractedCount++;
                    log.info(`✅ Extracted: ${firmName} (${extractedCount}/${maxLeads})`);
                }
            }

            // Pagination
            if (extractedCount < maxLeads) {
                const hasNextPage = await page.$('.pagination a.next, a.next-page, a:has-text("Next"), a[rel="next"], li.next a');
                if (hasNextPage) {
                    const nextUrl = await hasNextPage.getAttribute('href');
                    if (nextUrl) {
                        const absoluteUrl = new URL(nextUrl, 'https://www.yellowpages.com.sg').toString();
                        log.info(`Enqueuing next page: ${absoluteUrl}`);
                        await enqueueLinks({
                            urls: [absoluteUrl],
                        });
                    }
                } else {
                    const currentUrl = new URL(request.url);
                    let pageNum = 1;
                    if (currentUrl.searchParams.has('page')) {
                        pageNum = parseInt(currentUrl.searchParams.get('page'));
                        currentUrl.searchParams.set('page', (pageNum + 1).toString());
                    } else if (currentUrl.searchParams.has('p')) {
                        pageNum = parseInt(currentUrl.searchParams.get('p'));
                        currentUrl.searchParams.set('p', (pageNum + 1).toString());
                    } else {
                        const match = currentUrl.pathname.match(/\/(\d+)$/);
                        if(match) {
                            pageNum = parseInt(match[1]);
                            currentUrl.pathname = currentUrl.pathname.replace(/\/\d+$/, `/${pageNum+1}`);
                        } else {
                            currentUrl.pathname = currentUrl.pathname.replace(/\/$/, '') + '/2';
                        }
                    }
                    
                    if(pageNum < 10) { 
                        log.info(`Attempting synthetic pagination to: ${currentUrl.toString()}`);
                        await enqueueLinks({
                            urls: [currentUrl.toString()],
                        });
                    }
                }
            }
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Failed request: ${request.url}`);
        }
    });

    const formatKeyword = encodeURIComponent(keyword);
    // Generic URL for SG directories
    let startUrl = `https://www.yellowpages.com.sg/search/${formatKeyword}`;
    if (location && location.trim() !== '') {
        startUrl += `?location=${encodeURIComponent(location)}`;
    }
    
    await crawler.addRequests([{
        url: startUrl
    }]);

    await crawler.run();

    log.info(`🎉 Done! Extracted ${extractedCount} Singapore Accounting Firm leads.`);

} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
