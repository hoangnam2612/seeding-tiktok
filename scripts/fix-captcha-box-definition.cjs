const fs = require('fs');
const path = require('path');

const runnerPath = path.join(__dirname, '..', 'src', 'main', 'automation-runner.ts');
let content = fs.readFileSync(runnerPath, 'utf8');

const targetStr = `          const collectModalText = (root) => {
          if (!root) return '';
          let txt = (root.innerText || root.textContent || '') + ' ';
          const textEls = Array.from(root.querySelectorAll('[class*="title" i], [class*="tip" i], [class*="header" i], [class*="instruction" i], [class*="text" i], [class*="prompt" i], [class*="msg" i]')).filter(isVisible);
          textEls.forEach(el => { txt += ' ' + (el.innerText || el.textContent || ''); });
          const iframes = Array.from(root.querySelectorAll('iframe')).filter(isVisible);
          iframes.forEach(f => {
            txt += ' ' + (f.title || f.getAttribute('aria-label') || '');
          });
          return normalize(txt);
        };

        // Check if a slider button exists inside the captcha box
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

        const hasSlider = !!sliderEl;

        const detectTaskType = (root) => {
          const modalText = collectModalText(root);
          const allImgs = Array.from(root.querySelectorAll('img')).filter(isVisible);
          const hasTwoImages = allImgs.length >= 2;
          const hasCircleOrRotateImg = !!root.querySelector(
            '[class*="circle" i], [class*="round" i], [class*="rotate" i], img[class*="inner" i], img[class*="outer" i], div[style*="50%"], [id*="rotate" i]'
          );
          const hasRotateKeyword = /rotate|xoay|angle|upright|thang dung|dung chieu|goc quay|chieu dung|fit the shape|fit the puzzle|khop hinh/.test(modalText);

          // If there is a slider button: it is either Rotate or Slider puzzle
          if (hasSlider) {
            if (hasCircleOrRotateImg || hasRotateKeyword || (hasTwoImages && modalText.includes('puzzle'))) {
              return 'TiktokRotateWebTask';
            }
            return 'TiktokSliderWebTask';
          }

          // If there is NO slider button: it is a click/selection task (3D or Order)
          if (/3d|three[- ]?d|same object|same shape|matching object|2 doi tuong|hai doi tuong|cung hinh|cung doi tuong|giong nhau|khop vat the|2 vat the|vat the giong/.test(modalText)) {
            return 'Tiktok3DSelectObjectWebTask';
          }
          if (/select.*order|pick.*order|chon theo thu tu|chon doi tuong|chon vat the|chon hinh/.test(modalText)) {
            return 'TiktokSelectObjectWebTask';
          }
          if (/select|choose|pick|chon/.test(modalText) && /object|vat the|hinh|doi tuong/.test(modalText)) {
            return 'TiktokSelectObjectWebTask';
          }

          return 'Tiktok3DSelectObjectWebTask';
        };

        const taskType = detectTaskType(captchaBox);
          const boxRect = captchaBox.getBoundingClientRect();`;

const replaceStr = `          const isModalBox = (el) => {
            if (!isVisible(el)) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 200 && r.height >= 160 && r.width <= 750 && r.height <= 750;
          };

          const specificSelectors = [
            '#captcha-verify-container',
            '.captcha-verify-container',
            '#captcha_verify_container',
            '.captcha_verify_container',
            '.sec-captcha-container',
            '.captcha-container',
            '.verify-wrap',
            '[class*="captcha-card" i]',
            '[class*="captcha-modal" i]',
            '[class*="captcha_card" i]',
            '[class*="captcha_modal" i]',
            'iframe[src*="captcha"]',
            'iframe[src*="sec"]',
            'iframe[src*="verify"]',
            'iframe[src*="challenge"]',
            '[id*="captcha" i]',
            '[class*="captcha" i]'
          ];

          const allCandidates = specificSelectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
          let captchaBox = allCandidates.find(isModalBox);
          if (!captchaBox) {
            captchaBox = allCandidates.find(isVisible) || Array.from(document.querySelectorAll('iframe')).find(isVisible);
          }

          if (!captchaBox) return { found: false };

          const boxRect = captchaBox.getBoundingClientRect();

          const collectModalText = (root) => {
            if (!root) return '';
            let txt = (root.innerText || root.textContent || '') + ' ';
            const textEls = Array.from(root.querySelectorAll('[class*="title" i], [class*="tip" i], [class*="header" i], [class*="instruction" i], [class*="text" i], [class*="prompt" i], [class*="msg" i]')).filter(isVisible);
            textEls.forEach(el => { txt += ' ' + (el.innerText || el.textContent || ''); });
            const iframes = Array.from(root.querySelectorAll('iframe')).filter(isVisible);
            iframes.forEach(f => {
              txt += ' ' + (f.title || f.getAttribute('aria-label') || '');
            });
            return normalize(txt);
          };

          // Check if a slider button exists inside the captcha box
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

          const hasSlider = !!sliderEl;

          const detectTaskType = (root) => {
            const modalText = collectModalText(root);
            const allImgs = Array.from(root.querySelectorAll('img')).filter(isVisible);
            const hasTwoImages = allImgs.length >= 2;
            const hasCircleOrRotateImg = !!root.querySelector(
              '[class*="circle" i], [class*="round" i], [class*="rotate" i], img[class*="inner" i], img[class*="outer" i], div[style*="50%"], [id*="rotate" i]'
            );
            const hasRotateKeyword = /rotate|xoay|angle|upright|thang dung|dung chieu|goc quay|chieu dung|fit the shape|fit the puzzle|khop hinh/.test(modalText);

            // If there is a slider button: it is either Rotate or Slider puzzle
            if (hasSlider) {
              if (hasCircleOrRotateImg || hasRotateKeyword || (hasTwoImages && modalText.includes('puzzle'))) {
                return 'TiktokRotateWebTask';
              }
              return 'TiktokSliderWebTask';
            }

            // If there is NO slider button: it is a click/selection task (3D or Order)
            if (/3d|three[- ]?d|same object|same shape|matching object|2 doi tuong|hai doi tuong|cung hinh|cung doi tuong|giong nhau|khop vat the|2 vat the|vat the giong/.test(modalText)) {
              return 'Tiktok3DSelectObjectWebTask';
            }
            if (/select.*order|pick.*order|chon theo thu tu|chon doi tuong|chon vat the|chon hinh/.test(modalText)) {
              return 'TiktokSelectObjectWebTask';
            }
            if (/select|choose|pick|chon/.test(modalText) && /object|vat the|hinh|doi tuong/.test(modalText)) {
              return 'TiktokSelectObjectWebTask';
            }

            return 'Tiktok3DSelectObjectWebTask';
          };

          const taskType = detectTaskType(captchaBox);`;

content = content.replace(targetStr, replaceStr);
fs.writeFileSync(runnerPath, content, 'utf8');
console.log('Successfully restored captchaBox definition before usage!');
