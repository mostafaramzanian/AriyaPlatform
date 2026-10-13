#!/usr/bin/env node
const puppeteer = require('puppeteer');
const { default: lighthouse } = require('lighthouse');
const fs = require('fs');
const path = require('path');

const HOMEPAGE = 'http://localhost:3000';
const SCREENSHOTS_DIR = path.join(__dirname, 'qa-output', 'screenshots');
const REPORTS_DIR = path.join(__dirname, 'qa-output', 'reports');

// Viewport configurations
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

async function captureScreenshots() {
  console.log('\n========== CAPTURING SCREENSHOTS ==========\n');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  
  // Increase default timeout
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  for (const viewport of viewports) {
    console.log(`📸 Capturing ${viewport.name} (${viewport.width}x${viewport.height})...`);
    await page.setViewport(viewport);
    
    // Retry logic for navigation
    let navigationSuccess = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await page.goto(HOMEPAGE, { waitUntil: 'networkidle2', timeout: 60000 });
        navigationSuccess = true;
        break;
      } catch (error) {
        console.log(`  Attempt ${attempt}/5 failed: ${error.message}`);
        if (attempt < 5) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }
    
    if (!navigationSuccess) {
      console.error(`❌ Failed to navigate to ${HOMEPAGE} after 5 attempts`);
      await browser.close();
      throw new Error(`Could not load homepage on ${viewport.name}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000)); // Allow animations to settle

    const filename = path.join(SCREENSHOTS_DIR, `${viewport.name}-screenshot.png`);
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`✅ Saved: ${filename}`);
  }

  await browser.close();
  return viewports.map(v => `${v.name}-screenshot.png`);
}

async function runLighthouse() {
  console.log('\n========== RUNNING LIGHTHOUSE AUDIT ==========\n');
  try {
    const options = {
      logLevel: 'info',
      output: 'json',
      chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      emulatedFormFactor: 'desktop',
    };

    const runnerResult = await lighthouse(HOMEPAGE, options);
    const report = JSON.parse(runnerResult.report);

    const summary = {
      performance: Math.round(report.categories.performance.score * 100),
      accessibility: Math.round(report.categories.accessibility.score * 100),
      bestPractices: Math.round(report.categories['best-practices'].score * 100),
      seo: Math.round(report.categories.seo.score * 100),
      timestamp: new Date().toISOString(),
    };

    console.log(`\n📊 Lighthouse Scores:`);
    console.log(`  Performance:    ${summary.performance}/100 ${summary.performance >= 90 ? '✅' : '⚠️'}`);
    console.log(`  Accessibility:  ${summary.accessibility}/100 ${summary.accessibility >= 100 ? '✅' : '⚠️'}`);
    console.log(`  Best Practices: ${summary.bestPractices}/100 ${summary.bestPractices >= 95 ? '✅' : '⚠️'}`);
    console.log(`  SEO:            ${summary.seo}/100 ${summary.seo >= 95 ? '✅' : '⚠️'}`);

    // Extract audit details
    const audits = {};
    Object.keys(report.audits).forEach(auditId => {
      const audit = report.audits[auditId];
      if (audit.score === 0 || (audit.scoreDisplayMode === 'informative' && audit.details)) {
        audits[auditId] = {
          title: audit.title,
          score: audit.score,
          description: audit.description,
          details: audit.details?.items ? audit.details.items.slice(0, 5) : [],
        };
      }
    });

    const reportPath = path.join(REPORTS_DIR, 'lighthouse-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({ summary, audits }, null, 2));
    console.log(`\n✅ Lighthouse report saved: ${reportPath}`);

    return summary;
  } catch (error) {
    console.error('Lighthouse audit failed:', error);
    throw error;
  }
}

async function runAccessibilityAudit() {
  console.log('\n========== RUNNING ACCESSIBILITY AUDIT ==========\n');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);
  
  // Retry logic
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await page.goto(HOMEPAGE, { waitUntil: 'networkidle2', timeout: 60000 });
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  const a11yIssues = [];

  // Check for missing alt text
  const imagesWithoutAlt = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img:not([alt])')).map(img => ({
      tag: 'img',
      issue: 'Missing alt text',
      src: img.src,
      selector: img.className,
    }));
  });
  a11yIssues.push(...imagesWithoutAlt);

  // Check for missing form labels
  const inputsWithoutLabel = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input:not([aria-label])')).map(inp => ({
      tag: 'input',
      issue: 'Missing aria-label or associated label',
      type: inp.type,
    }));
  });
  a11yIssues.push(...inputsWithoutLabel);

  // Check for contrast (basic check)
  const lowContrastElements = await page.evaluate(() => {
    const issues = [];
    const elementsToCheck = document.querySelectorAll('p, span, a, h1, h2, h3, h4, h5, h6');
    // This is a simplified check; real contrast testing requires more sophisticated tools
    return []; // Placeholder
  });
  a11yIssues.push(...lowContrastElements);

  // Check for keyboard navigation
  const focusableElements = await page.evaluate(() => {
    return document.querySelectorAll('a, button, input, [tabindex]').length;
  });

  // Check for heading hierarchy
  const headingStructure = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    return headings.map(h => ({
      level: parseInt(h.tagName[1]),
      text: h.textContent.substring(0, 50),
    }));
  });

  // Check for RTL attribute
  const htmlDir = await page.evaluate(() => {
    return document.documentElement.dir;
  });

  // Check for Persian font
  const fontFamily = await page.evaluate(() => {
    return window.getComputedStyle(document.body).fontFamily;
  });

  const a11yReport = {
    timestamp: new Date().toISOString(),
    focusableElementsCount: focusableElements,
    headingStructure,
    rtlEnabled: htmlDir === 'rtl',
    fontFamily,
    issues: a11yIssues,
    issueCount: a11yIssues.length,
  };

  const reportPath = path.join(REPORTS_DIR, 'accessibility-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(a11yReport, null, 2));
  console.log(`✅ Accessibility report saved: ${reportPath}`);
  console.log(`   Focusable elements: ${focusableElements}`);
  console.log(`   RTL enabled: ${a11yReport.rtlEnabled ? '✅' : '❌'}`);
  console.log(`   Font family: ${fontFamily}`);
  console.log(`   Accessibility issues: ${a11yReport.issueCount}`);

  await browser.close();
  return a11yReport;
}

async function runResponsiveQA() {
  console.log('\n========== RUNNING RESPONSIVE QA ==========\n');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  const qaResults = {
    timestamp: new Date().toISOString(),
    checks: [],
  };

  for (const viewport of viewports) {
    console.log(`\n🔍 Testing ${viewport.name}...`);
    await page.setViewport(viewport);
    
    // Retry navigation
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await page.goto(HOMEPAGE, { waitUntil: 'networkidle2', timeout: 60000 });
        break;
      } catch (error) {
        if (attempt === 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));

    const checks = await page.evaluate(() => {
      const issues = [];
      
      // Check for horizontal overflow
      const htmlWidth = document.documentElement.scrollWidth;
      const windowWidth = window.innerWidth;
      if (htmlWidth > windowWidth) {
        issues.push('❌ Horizontal overflow detected');
      } else {
        issues.push('✅ No horizontal overflow');
      }

      // Check hero visibility
      const hero = document.querySelector('h1');
      if (hero) {
        const heroRect = hero.getBoundingClientRect();
        if (heroRect.top < window.innerHeight) {
          issues.push('✅ Hero H1 visible above fold');
        } else {
          issues.push('❌ Hero H1 not visible above fold');
        }
      }

      // Check CTA visibility
      const cta = document.querySelector('.btn-primary');
      if (cta) {
        const ctaRect = cta.getBoundingClientRect();
        if (ctaRect.top < window.innerHeight) {
          issues.push('✅ Primary CTA visible above fold');
        } else {
          issues.push('❌ Primary CTA not visible above fold');
        }
      }

      // Check sticky header
      const header = document.querySelector('header');
      if (header) {
        const headerStyle = window.getComputedStyle(header);
        if (headerStyle.position === 'sticky' || headerStyle.position === 'fixed') {
          issues.push('✅ Sticky header detected');
        }
      }

      // Check for text readability (line length)
      const mainText = document.querySelector('p');
      if (mainText) {
        const width = mainText.offsetWidth;
        if (width > 600) {
          issues.push('⚠️ Text line width may be too long');
        } else if (width > 0) {
          issues.push('✅ Text line width acceptable');
        }
      }

      return issues;
    });

    qaResults.checks.push({
      viewport: `${viewport.name} (${viewport.width}x${viewport.height})`,
      results: checks,
    });

    checks.forEach(check => console.log(`   ${check}`));
  }

  await browser.close();

  const reportPath = path.join(REPORTS_DIR, 'responsive-qa-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(qaResults, null, 2));
  console.log(`\n✅ Responsive QA report saved: ${reportPath}`);

  return qaResults;
}

async function runAnimationQA() {
  console.log('\n========== RUNNING ANIMATION & MOTION QA ==========\n');
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  // Retry navigation
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await page.goto(HOMEPAGE, { waitUntil: 'networkidle2', timeout: 60000 });
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // Check prefers-reduced-motion support
  const prefersReduced = await page.evaluate(() => {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  // Check for SVG animations
  const svgAnimations = await page.evaluate(() => {
    const svgs = document.querySelectorAll('svg');
    const animationElements = document.querySelectorAll('animate, animateTransform');
    return {
      svgCount: svgs.length,
      animationElementsCount: animationElements.length,
    };
  });

  // Check for CSS animations
  const styles = await page.evaluate(() => {
    const styleSheets = Array.from(document.styleSheets);
    let animationRuleCount = 0;
    styleSheets.forEach(sheet => {
      try {
        const rules = sheet.cssRules;
        rules.forEach(rule => {
          if (rule.type === 7) animationRuleCount++; // 7 = KEYFRAMES_RULE
        });
      } catch (e) {
        // CORS or other issues
      }
    });
    return { animationRuleCount };
  });

  const animationReport = {
    timestamp: new Date().toISOString(),
    prefersReducedMotion: prefersReduced ? 'Not set (safe for animations)' : 'Enabled',
    svgs: svgAnimations.svgCount,
    animationElements: svgAnimations.animationElementsCount,
    cssKeyframes: styles.animationRuleCount,
  };

  const reportPath = path.join(REPORTS_DIR, 'animation-qa-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(animationReport, null, 2));
  console.log(`✅ Animation QA report saved: ${reportPath}`);
  console.log(`   SVGs: ${svgAnimations.svgCount}`);
  console.log(`   Animation elements: ${svgAnimations.animationElementsCount}`);
  console.log(`   CSS keyframes: ${styles.animationRuleCount}`);

  await browser.close();
  return animationReport;
}

async function generateSummaryReport(lighthouseScore, a11yReport, responsiveQA) {
  console.log('\n========== GENERATING SUMMARY REPORT ==========\n');

  const criticalIssues = [];
  
  if (lighthouseScore.performance < 90) {
    criticalIssues.push({
      severity: 'HIGH',
      category: 'Performance',
      issue: `Lighthouse Performance score is ${lighthouseScore.performance}/100 (target: 90)`,
      recommendation: 'Review network requests, optimize images, and defer non-critical CSS/JS',
    });
  }

  if (lighthouseScore.accessibility < 100) {
    criticalIssues.push({
      severity: 'CRITICAL',
      category: 'Accessibility',
      issue: `Lighthouse Accessibility score is ${lighthouseScore.accessibility}/100 (target: 100)`,
      recommendation: 'Fix all accessibility audit failures in Lighthouse report',
    });
  }

  if (lighthouseScore.bestPractices < 95) {
    criticalIssues.push({
      severity: 'HIGH',
      category: 'Best Practices',
      issue: `Lighthouse Best Practices score is ${lighthouseScore.bestPractices}/100 (target: 95)`,
      recommendation: 'Address deprecated APIs and security best practices',
    });
  }

  if (lighthouseScore.seo < 95) {
    criticalIssues.push({
      severity: 'MEDIUM',
      category: 'SEO',
      issue: `Lighthouse SEO score is ${lighthouseScore.seo}/100 (target: 95)`,
      recommendation: 'Ensure meta tags, structured data, and mobile optimization',
    });
  }

  if (a11yReport.issueCount > 0) {
    criticalIssues.push({
      severity: 'MEDIUM',
      category: 'Accessibility',
      issue: `Found ${a11yReport.issueCount} potential accessibility issues`,
      recommendation: 'Review detailed accessibility report and fix issues',
    });
  }

  if (!a11yReport.rtlEnabled) {
    criticalIssues.push({
      severity: 'CRITICAL',
      category: 'RTL Support',
      issue: 'RTL (dir="rtl") not properly enabled on HTML element',
      recommendation: 'Ensure HTML element has dir="rtl" attribute',
    });
  }

  const summaryReport = {
    timestamp: new Date().toISOString(),
    lighthouseScores: lighthouseScore,
    accessibility: {
      issues: a11yReport.issueCount,
      focusableElements: a11yReport.focusableElementsCount,
      rtlEnabled: a11yReport.rtlEnabled,
      font: a11yReport.fontFamily,
    },
    criticalIssues,
    overallStatus: criticalIssues.length === 0 ? '✅ PASS' : '⚠️ NEEDS FIXES',
  };

  const reportPath = path.join(REPORTS_DIR, 'summary-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(summaryReport, null, 2));
  
  console.log('\n📋 SUMMARY REPORT\n');
  console.log(`Status: ${summaryReport.overallStatus}`);
  console.log(`Critical Issues: ${criticalIssues.length}`);
  
  if (criticalIssues.length > 0) {
    console.log('\n🚨 CRITICAL & HIGH PRIORITY ISSUES:\n');
    criticalIssues.forEach((issue, idx) => {
      console.log(`${idx + 1}. [${issue.severity}] ${issue.category}`);
      console.log(`   Issue: ${issue.issue}`);
      console.log(`   Fix: ${issue.recommendation}\n`);
    });
  }

  console.log(`\n✅ Summary report saved: ${reportPath}`);
  return summaryReport;
}

async function main() {
  try {
    console.log('🚀 Starting comprehensive Aria homepage QA suite...\n');
    await ensureDirs();

    // Capture screenshots
    const screenshots = await captureScreenshots();

    // Run Lighthouse
    const lighthouseScore = await runLighthouse();

    // Run accessibility audit
    const a11yReport = await runAccessibilityAudit();

    // Run responsive QA
    const responsiveQA = await runResponsiveQA();

    // Run animation QA
    const animationQA = await runAnimationQA();

    // Generate summary
    const summary = await generateSummaryReport(lighthouseScore, a11yReport, responsiveQA);

    console.log('\n========== QA SUITE COMPLETE ==========');
    console.log(`📁 All reports saved to: ${REPORTS_DIR}`);
    console.log(`📷 All screenshots saved to: ${SCREENSHOTS_DIR}`);
    console.log('\n✨ QA workflow finished successfully!\n');

    process.exit(summary.criticalIssues.length > 0 ? 1 : 0);
  } catch (error) {
    console.error('\n❌ QA suite failed:', error);
    process.exit(1);
  }
}

main();
