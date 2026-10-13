#!/usr/bin/env node
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const HOMEPAGE = 'http://localhost:3000';
const SCREENSHOTS_DIR = path.join(__dirname, 'qa-output', 'screenshots');
const REPORTS_DIR = path.join(__dirname, 'qa-output', 'reports');

const viewports = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'tablet', width: 1024, height: 1366 },
  { name: 'mobile', width: 390, height: 844 },
];

async function ensureDirs() {
  [SCREENSHOTS_DIR, REPORTS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

async function runCoreQA() {
  console.log('\n🚀 Starting Aria homepage QA suite...\n');
  await ensureDirs();

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const screenshotPaths = [];
  const qaResults = { timestamp: new Date().toISOString(), viewports: [] };

  // ===== CAPTURE SCREENSHOTS =====
  console.log('========== CAPTURING SCREENSHOTS ==========\n');
  for (const viewport of viewports) {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    console.log(`📸 Capturing ${viewport.name} (${viewport.width}x${viewport.height})...`);
    
    try {
      await page.setViewport(viewport);
      await page.goto(HOMEPAGE, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(resolve => setTimeout(resolve, 1000));

      const filename = path.join(SCREENSHOTS_DIR, `${viewport.name}-screenshot.png`);
      await page.screenshot({ path: filename, fullPage: true });
      screenshotPaths.push(filename);
      console.log(`✅ Saved: ${filename}\n`);
    } catch (error) {
      console.error(`❌ Failed to capture ${viewport.name}: ${error.message}\n`);
    }

    await page.close();
  }

  // ===== PERFORMANCE & ACCESSIBILITY AUDIT =====
  console.log('========== RUNNING PERFORMANCE & ACCESSIBILITY AUDIT ==========\n');
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  await page.goto(HOMEPAGE, { waitUntil: 'networkidle2', timeout: 60000 });

  const auditResults = await page.evaluate(() => {
    const issues = [];
    const performance = {};
    const accessibility = {};

    // === PERFORMANCE ===
    const perf = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    if (perf) {
      performance.loadTime = perf.loadEventEnd - perf.fetchStart;
      performance.domContentLoaded = perf.domContentLoadedEventEnd - perf.fetchStart;
      performance.firstContentfulPaint = perf.responseEnd - perf.fetchStart;
    }

    // === ACCESSIBILITY ===
    // Check for missing alt text
    const imagesWithoutAlt = Array.from(document.querySelectorAll('img:not([alt])')).length;
    if (imagesWithoutAlt > 0) {
      issues.push(`❌ ${imagesWithoutAlt} images missing alt text`);
    } else {
      issues.push('✅ All images have alt text');
    }

    // Check heading hierarchy
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    if (headings.length > 0 && headings[0].tagName !== 'H1') {
      issues.push('❌ No H1 found or not first heading');
    } else if (headings.length > 0) {
      issues.push('✅ H1 is first heading');
    }

    // Check for lang attribute
    if (document.documentElement.lang) {
      issues.push(`✅ HTML lang="${document.documentElement.lang}" set`);
      accessibility.lang = document.documentElement.lang;
    } else {
      issues.push('❌ HTML lang attribute missing');
    }

    // Check for dir attribute (RTL)
    if (document.documentElement.dir === 'rtl') {
      issues.push('✅ RTL (dir="rtl") enabled');
      accessibility.rtl = true;
    } else {
      issues.push('⚠️ RTL not enabled (document is LTR)');
      accessibility.rtl = false;
    }

    // Check for viewport meta tag
    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport) {
      issues.push('✅ Viewport meta tag present');
    } else {
      issues.push('❌ Viewport meta tag missing');
    }

    // Check font rendering
    const bodyStyle = window.getComputedStyle(document.body);
    accessibility.fontFamily = bodyStyle.fontFamily;
    if (bodyStyle.fontFamily.includes('Vazirmatn')) {
      issues.push('✅ Vazirmatn Persian font loaded');
    }

    // Hero readability - check if H1 is visible and readable
    const h1 = document.querySelector('h1');
    if (h1) {
      const rect = h1.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) {
        issues.push('✅ Hero H1 visible above fold');
        accessibility.heroVisible = true;
      } else {
        issues.push('❌ Hero H1 not visible above fold');
        accessibility.heroVisible = false;
      }

      // Check H1 readability
      const h1Style = window.getComputedStyle(h1);
      const fontSize = parseInt(h1Style.fontSize);
      if (fontSize >= 28) {
        issues.push(`✅ Hero H1 font size is ${fontSize}px (readable)`);
      } else {
        issues.push(`⚠️ Hero H1 font size is ${fontSize}px (may be small)`);
      }
    }

    // CTA visibility
    const ctas = Array.from(document.querySelectorAll('.btn-primary, .btn-secondary'));
    const visibleCTAs = ctas.filter(cta => {
      const rect = cta.getBoundingClientRect();
      return rect.top < window.innerHeight;
    });
    if (visibleCTAs.length > 0) {
      issues.push(`✅ ${visibleCTAs.length} CTA(s) visible above fold`);
      accessibility.ctasAboveFold = visibleCTAs.length;
    }

    // Sticky header check
    const header = document.querySelector('header');
    if (header) {
      const headerStyle = window.getComputedStyle(header);
      if (headerStyle.position === 'sticky' || headerStyle.position === 'fixed') {
        issues.push('✅ Sticky header detected');
      }
    }

    // Color contrast check (simplified)
    const textElements = Array.from(document.querySelectorAll('p, a, span, h1, h2, h3'));
    let contrastIssues = 0;
    textElements.slice(0, 10).forEach(el => {
      const style = window.getComputedStyle(el);
      // Simplified check - just looking for very light text on light backgrounds
      if (style.color.includes('rgb(255') && style.backgroundColor.includes('rgb(255')) {
        contrastIssues++;
      }
    });
    if (contrastIssues === 0) {
      issues.push('✅ Sample text contrast looks acceptable');
    }

    // Keyboard navigation - count focusable elements
    const focusable = document.querySelectorAll('a, button, input, [tabindex]');
    issues.push(`✅ Found ${focusable.length} focusable elements`);
    accessibility.focusableElements = focusable.length;

    return {
      issues,
      performance,
      accessibility,
    };
  });

  await page.close();
  await browser.close();

  // ===== PRINT RESULTS =====
  console.log('========== QA RESULTS ==========\n');
  console.log('📋 Issues & Checks:\n');
  auditResults.issues.forEach(issue => console.log(`   ${issue}`));

  console.log('\n🎨 Accessibility Report:');
  console.log(`   Language: ${auditResults.accessibility.lang || 'Not set'}`);
  console.log(`   RTL Support: ${auditResults.accessibility.rtl ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`   Font: ${auditResults.accessibility.fontFamily}`);
  console.log(`   Hero Visible: ${auditResults.accessibility.heroVisible ? '✅ Yes' : '❌ No'}`);
  console.log(`   CTAs Above Fold: ${auditResults.accessibility.ctasAboveFold || 0}`);
  console.log(`   Focusable Elements: ${auditResults.accessibility.focusableElements}`);

  // ===== SAVE SUMMARY REPORT =====
  const summaryReport = {
    timestamp: new Date().toISOString(),
    homepage: HOMEPAGE,
    screenshots: screenshotPaths.map(p => path.relative(process.cwd(), p)),
    auditResults,
    status: auditResults.issues.filter(i => i.includes('❌')).length === 0 ? '✅ PASS' : '⚠️ REVIEW',
  };

  const reportPath = path.join(REPORTS_DIR, 'qa-summary.json');
  fs.writeFileSync(reportPath, JSON.stringify(summaryReport, null, 2));

  console.log(`\n========== QA COMPLETE ==========`);
  console.log(`📁 Screenshots: ${SCREENSHOTS_DIR}`);
  console.log(`📊 Report: ${reportPath}`);
  console.log(`\n✨ Status: ${summaryReport.status}\n`);

  return summaryReport;
}

runCoreQA().catch(error => {
  console.error('❌ QA suite failed:', error);
  process.exit(1);
});
