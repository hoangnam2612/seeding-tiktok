const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
let content = fs.readFileSync(runnerPath, 'utf8');

// Replace the DOM measurement and slider/track detection inside solveTikTokWebCaptchaWithOmo
const oldDetectRegex = /const sliderCandidates = Array\.from\(document\.querySelectorAll\([\s\S]*?const questionText = titleEl \? \(titleEl\.innerText \|\| titleEl\.textContent \|\| ''\)\.trim\(\) : 'Select 2 objects with the same shape';/;

const newDetectCode = `// 1. Locate the exact slider thumb button
        const specificSliderSelectors = [
          '.captcha_verify_slide--slidebtn',
          '.sec-captcha-slider-btn',
          '[class*="slidebtn" i]',
          '[class*="slider-btn" i]',
          '[class*="drag-btn" i]',
          '[class*="sec-slider" i]',
          '[class*="slider-thumb" i]',
          '[role="slider"]',
          'div[class*="btn" i][class*="slide" i]',
          'div[class*="button" i][class*="slide" i]'
        ];

        let sliderEl = specificSliderSelectors
          .flatMap(sel => Array.from(captchaBox.querySelectorAll(sel)))
          .find(isVisible);

        if (!sliderEl) {
          const fallbackSliders = Array.from(captchaBox.querySelectorAll('div, span, button, [role="button"]')).filter(el => {
            if (!isVisible(el)) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 24 && r.width <= 65 && r.height >= 24 && r.height <= 65 &&
                   r.top >= boxRect.bottom - 120 && r.bottom <= boxRect.bottom + 20;
          });
          sliderEl = fallbackSliders.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
        }

        const sliderRect = sliderEl ? sliderEl.getBoundingClientRect() : null;

        // 2. Locate the EXACT track element directly hosting the slider button
        let trackEl = null;
        if (sliderEl) {
          // Check if parent or closest container is the track bar (height 20-55px, width > 150px)
          let parent = sliderEl.parentElement;
          while (parent && parent !== captchaBox && parent !== document.body) {
            const pr = parent.getBoundingClientRect();
            if (pr.width >= 160 && pr.height >= 20 && pr.height <= 65 && Math.abs(pr.top - (sliderRect?.top || 0)) <= 15) {
              trackEl = parent;
              break;
            }
            parent = parent.parentElement;
          }
        }

        if (!trackEl) {
          const specificTrackSelectors = [
            '.captcha_verify_slide--slidebar',
            '.sec-captcha-slider-track',
            '[class*="slidebar" i]',
            '[class*="slider-track" i]',
            '[class*="slider-bg" i]',
            '[class*="drag-bar" i]',
            '[class*="slide_bar" i]',
            '[class*="drag-track" i]',
            '[class*="rail" i]'
          ];
          trackEl = specificTrackSelectors
            .flatMap(sel => Array.from(captchaBox.querySelectorAll(sel)))
            .find(el => {
              if (!isVisible(el)) return false;
              const r = el.getBoundingClientRect();
              return r.width >= 160 && r.height >= 10 && r.height <= 65;
            });
        }

        const trackRect = trackEl ? trackEl.getBoundingClientRect() : (sliderRect ? {
          left: boxRect.left + 15,
          top: sliderRect.top,
          width: boxRect.width - 30,
          height: sliderRect.height
        } : null);

        const titleEl = document.querySelector('[class*="title" i], [class*="tip" i], [class*="header" i], [class*="instruction" i], [class*="prompt" i], [class*="msg" i]');
        const questionText = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : 'Select 2 objects with the same shape';`;

content = content.replace(oldDetectRegex, newDetectCode);

// Also replace the dragging logic in solveTikTokWebCaptchaWithOmo to use exact maxTravel
const oldDragLogicRegex = /const startX = Math\.round\(captchaData\.slider\?\.x \|\| \(captchaData\.rect\.x \+ 38\)\);[\s\S]*?if \(!applied\) \{/m;

const newDragLogicCode = `const sliderWidth = captchaData.slider?.width || 40;
    const trackWidth = captchaData.track?.width || (captchaData.rect.width - 30);
    const startX = Math.round(captchaData.slider?.x || (captchaData.rect.x + sliderWidth / 2 + 10));
    const startY = Math.round(captchaData.slider?.y || (captchaData.rect.y + captchaData.rect.height - 35));
    // Exact travel length of the slider button inside the track
    const maxTravel = Math.max(40, trackWidth - sliderWidth);

    const dragByRatio = async (ratio: number) => {
      const clampedRatio = Math.max(0, Math.min(1, ratio));
      const travel = Math.round(maxTravel * clampedRatio);
      const endX = startX + travel;
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: \`[Captcha] 🖱️ Đang kéo slider: Tỷ lệ \${(clampedRatio * 100).toFixed(1)}% (Từ \${startX}px đến \${endX}px, cự ly \${travel}px/\${maxTravel}px)...\`,
      });
      await performCdpDrag(win, startX, startY, endX, startY);
    };

    let applied = false;
    if (solution?.pointA && solution?.pointB) {
      await performCdpClick(win, captchaData.rect.x + Number(solution.pointA.x || 0), captchaData.rect.y + Number(solution.pointA.y || 0));
      await performCdpClick(win, captchaData.rect.x + Number(solution.pointB.x || 0), captchaData.rect.y + Number(solution.pointB.y || 0));
      applied = true;
    } else if (solution?.point1 && solution?.point2) {
      await performCdpClick(win, captchaData.rect.x + Number(solution.point1.x || 0), captchaData.rect.y + Number(solution.point1.y || 0));
      await performCdpClick(win, captchaData.rect.x + Number(solution.point2.x || 0), captchaData.rect.y + Number(solution.point2.y || 0));
      applied = true;
    } else if (Array.isArray(solution?.points) && solution.points.length > 0) {
      for (const pt of solution.points.slice(0, 6)) {
        await performCdpClick(win, captchaData.rect.x + Number(pt.x || 0), captchaData.rect.y + Number(pt.y || 0));
      }
      applied = true;
    } else if (Array.isArray(solution) && solution.length > 0 && typeof solution[0]?.x === 'number') {
      for (const pt of solution.slice(0, 6)) {
        await performCdpClick(win, captchaData.rect.x + Number(pt.x || 0), captchaData.rect.y + Number(pt.y || 0));
      }
      applied = true;
    } else if (solution?.point && typeof solution.point.x === 'number') {
      await performCdpClick(win, captchaData.rect.x + Number(solution.point.x || 0), captchaData.rect.y + Number(solution.point.y || 0));
      applied = true;
    } else if (Array.isArray(solution?.objects) && solution.objects.length > 0) {
      for (const objectIndex of solution.objects.slice(0, 6)) {
        const index = Math.max(0, Number(objectIndex) || 0);
        const col = index % 3;
        const row = Math.floor(index / 3);
        const clickX = captchaData.rect.x + (captchaData.rect.width * (col + 0.5) / 3);
        const clickY = captchaData.rect.y + (captchaData.rect.height * (row + 0.5) / 2);
        await performCdpClick(win, clickX, clickY);
      }
      applied = true;
    } else if (solution?.end && typeof solution.end.x === 'number') {
      // In Slider jigsaw puzzle, end.x is the target X position inside widthView
      const widthView = captchaData.widthView || captchaData.rect.width || 340;
      const sliderRatio = Math.max(0, Math.min(1, Number(solution.end.x) / widthView));
      await dragByRatio(sliderRatio);
      applied = true;
    } else if (typeof solution?.distance === 'number') {
      const widthView = captchaData.widthView || captchaData.rect.width || 340;
      const sliderRatio = Math.max(0, Math.min(1, solution.distance / widthView));
      await dragByRatio(sliderRatio);
      applied = true;
    } else if (typeof solution?.rotate === 'number' || typeof solution?.angle === 'number' || typeof solution?.degrees === 'number') {
      const val = Number(solution.rotate ?? solution.angle ?? solution.degrees);
      const ratio = Math.abs(val) <= 1 ? Math.abs(val) : (Math.abs(val) / 360);
      await dragByRatio(ratio);
      applied = true;
    } else if (typeof solution?.value === 'number' || typeof solution?.ratio === 'number' || typeof solution?.percent === 'number') {
      const val = Number(solution.value ?? solution.ratio ?? solution.percent);
      const ratio = Math.abs(val) <= 1 ? Math.abs(val) : (Math.abs(val) / 100);
      await dragByRatio(ratio);
      applied = true;
    } else if (typeof solution === 'number') {
      const ratio = solution <= 1 ? solution : (solution / 360);
      await dragByRatio(ratio);
      applied = true;
    }

    if (!applied) {`;

content = content.replace(oldDragLogicRegex, newDragLogicCode);
fs.writeFileSync(runnerPath, content, 'utf8');
console.log('Successfully patched exact track measurement in automation-runner.ts!');
