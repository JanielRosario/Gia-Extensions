// ==UserScript==
// @name         Zillow and Google Maps Links for PolicyCenter
// @namespace    GPG_Scripts
// @version      2.5
// @description  Add buttons for Zillow and Google Maps to PolicyCenter/Guidewire
// @match        https://policycenter.farmersinsurance.com/pc/PolicyCenter.do*
// @match        https://policycenter-2.farmersinsurance.com/pc/PolicyCenter.do*
// @match        https://policycenter-3.farmersinsurance.com/pc/PolicyCenter.do*
// @grant        none
// @author       Mr.G
// @updateURL    https://raw.githubusercontent.com/ugomez809/GIA-TamperMonkey/main/GWPC-Zillow-GoogleMaps-Links/policycenter-zillow-googlemaps.user.js
// @downloadURL  https://raw.githubusercontent.com/ugomez809/GIA-TamperMonkey/main/GWPC-Zillow-GoogleMaps-Links/policycenter-zillow-googlemaps.user.js
// ==/UserScript==

(function () {
    'use strict';

    const ROOT_ATTR = 'data-gpg-property-links-root';
    const SCREEN_ATTR = 'data-gpg-property-links-screen';
    const BUTTON_CLASS = 'gpg-property-link-button';

    const SCREEN_CONFIGS = [
        {
            key: 'submission',
            mountSelectors: [
                '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingSingleHOEPanelSet-HODwellingDetailsHOEDV-0'
            ],
            addressSelectors: [
                '[id^="SubmissionWizard"][id*="Address"] .gw-link.gw-label',
                '[id^="SubmissionWizard"][id*="Address"] .gw-value-readonly-wrapper',
                '[id^="SubmissionWizard"][id*="Address"] input',
                '[id^="SubmissionWizard"][id*="Location"] .gw-link.gw-label'
            ]
        },
        {
            key: 'existingPolicy',
            mountSelectors: [
                '#PolicyFileDwellingHOE-PolicyFile_Homeowners_Dwelling_Screen-HODwellingSingleHOEPanelSet-HODwellingDetailsHOEDV-0'
            ],
            addressSelectors: [
                '#PolicyFileAccountFile_Summary-Summary_PolicyInfoDV-Address .gw-link.gw-label',
                '#PolicyFileAccountFile_Summary-Summary_PolicyInfoDV-Address .gw-value-readonly-wrapper',
                '[id^="PolicyFile"][id*="Address"] .gw-link.gw-label',
                '[id^="PolicyFile"][id*="Address"] .gw-value-readonly-wrapper'
            ]
        },
        {
            key: 'policyChange',
            mountSelectors: [
                '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingSingleHOEPanelSet-HODwellingDetailsHOEDV-0'
            ],
            addressSelectors: [
                '[id^="PolicyChangeWizard"][id*="Address"] .gw-link.gw-label',
                '[id^="PolicyChangeWizard"][id*="Address"] .gw-value-readonly-wrapper',
                '[id^="PolicyChangeWizard"][id*="Address"] input',
                '[id^="PolicyChangeWizard"][id*="Location"] .gw-link.gw-label'
            ]
        }
    ];

    const SHARED_ADDRESS_SELECTORS = [
        '[id*="Address"] .gw-link.gw-label',
        '[id*="Address"] .gw-value-readonly-wrapper',
        '[id*="Address"] input',
        '[id*="Location"] .gw-link.gw-label',
        '.gw-link.gw-label'
    ];

    const uniqueElements = (selectors, scope) => {
        const root = scope || document;
        const seen = new Set();
        const results = [];

        selectors.forEach((selector) => {
            root.querySelectorAll(selector).forEach((element) => {
                if (!seen.has(element)) {
                    seen.add(element);
                    results.push(element);
                }
            });
        });

        return results;
    };

    const readElementValue = (element) => {
        if (!element) {
            return '';
        }

        if ('value' in element && typeof element.value === 'string') {
            return element.value.trim();
        }

        return (element.textContent || '').trim();
    };

    const normalizeAddress = (value) => value.replace(/\s+/g, ' ').trim();

    const scoreAddressCandidate = (text, element, mountElement) => {
        let score = 0;

        if (/^\d+/.test(text)) {
            score += 8;
        }

        if (/\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|way|blvd|boulevard)\b/i.test(text)) {
            score += 6;
        }

        if (text.includes(',')) {
            score += 2;
        }

        if (/\b\d{5}(?:-\d{4})?\b/.test(text)) {
            score += 3;
        }

        if (element.closest('[id*="Address"], [id*="Location"]')) {
            score += 4;
        }

        if (mountElement && mountElement.contains(element)) {
            score += 2;
        }

        if (element.matches('.gw-link.gw-label')) {
            score += 1;
        }

        return score;
    };

    const findAddress = (screenConfig, mountElement) => {
        const scopedCandidates = uniqueElements(
            [...screenConfig.addressSelectors, ...SHARED_ADDRESS_SELECTORS],
            mountElement
        );
        const globalCandidates = uniqueElements([...screenConfig.addressSelectors, ...SHARED_ADDRESS_SELECTORS]);
        const candidates = [...scopedCandidates];

        globalCandidates.forEach((element) => {
            if (!candidates.includes(element)) {
                candidates.push(element);
            }
        });

        let best = null;

        candidates.forEach((element) => {
            const text = normalizeAddress(readElementValue(element));
            if (!text) {
                return;
            }

            const score = scoreAddressCandidate(text, element, mountElement);
            if (!best || score > best.score) {
                best = { element, text, score };
            }
        });

        return best ? best.text : '';
    };

    const buildZillowUrl = (address) => `https://www.zillow.com/homes/${encodeURIComponent(address)}`;

    const buildGoogleMapsUrl = (address) =>
        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

    const findMountTarget = () => {
        for (const screenConfig of SCREEN_CONFIGS) {
            for (const selector of screenConfig.mountSelectors) {
                const element = document.querySelector(selector);
                if (element) {
                    return { screenConfig, element };
                }
            }
        }

        return null;
    };

    const isRootMountedOnTarget = (root, target) => {
        if (!root || !target || !target.element) {
            return false;
        }

        return target.element.contains(root) && root.getAttribute(SCREEN_ATTR) === target.screenConfig.key;
    };

    const removeStaleRoots = (target) => {
        document.querySelectorAll(`[${ROOT_ATTR}="true"]`).forEach((root) => {
            if (!isRootMountedOnTarget(root, target)) {
                root.remove();
            }
        });
    };

    const createButton = (text, color, getUrl) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = BUTTON_CLASS;
        button.textContent = text;

        Object.assign(button.style, {
            margin: '10px 10px 0 0',
            padding: '5px 10px',
            cursor: 'pointer',
            backgroundColor: color,
            color: '#fff',
            border: 'none',
            borderRadius: '4px'
        });

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            const url = getUrl();
            if (!url) {
                scheduleSync();
                return;
            }

            window.open(url, '_blank', 'noopener');
        });

        return button;
    };

    const getExistingRoot = (target) => {
        if (!target) {
            return null;
        }

        return Array.from(target.element.children).find(
            (child) =>
                child.getAttribute &&
                child.getAttribute(ROOT_ATTR) === 'true' &&
                child.getAttribute(SCREEN_ATTR) === target.screenConfig.key
        ) || null;
    };

    const refreshButtonState = (root, screenConfig, mountElement) => {
        if (!root) {
            return;
        }

        const address = findAddress(screenConfig, mountElement);
        const hasAddress = Boolean(address);

        root.querySelectorAll(`.${BUTTON_CLASS}`).forEach((button) => {
            button.disabled = !hasAddress;
            button.style.opacity = hasAddress ? '1' : '0.65';
            button.style.cursor = hasAddress ? 'pointer' : 'not-allowed';
            button.title = hasAddress ? '' : 'Waiting for a valid address';
        });
    };

    const ensureButtons = () => {
        const target = findMountTarget();
        if (!target) {
            return;
        }

        removeStaleRoots(target);

        let root = getExistingRoot(target);
        if (!root) {
            root = document.createElement('div');
            root.setAttribute(ROOT_ATTR, 'true');
            root.setAttribute(SCREEN_ATTR, target.screenConfig.key);
            root.style.display = 'flex';
            root.style.flexWrap = 'wrap';
            root.style.alignItems = 'center';

            const zillowButton = createButton('Open in Zillow', '#0074cc', () => {
                const address = findAddress(target.screenConfig, target.element);
                return address ? buildZillowUrl(address) : '';
            });

            const mapsButton = createButton('Open in Google Maps', '#34a853', () => {
                const address = findAddress(target.screenConfig, target.element);
                return address ? buildGoogleMapsUrl(address) : '';
            });

            root.appendChild(zillowButton);
            root.appendChild(mapsButton);
            target.element.appendChild(root);
        }

        refreshButtonState(root, target.screenConfig, target.element);
    };

    let syncScheduled = false;

    function scheduleSync() {
        if (syncScheduled) {
            return;
        }

        syncScheduled = true;

        window.setTimeout(() => {
            syncScheduled = false;
            ensureButtons();
        }, 75);
    }

    const observerTarget = document.body || document.documentElement;
    const observer = new MutationObserver(scheduleSync);
    observer.observe(observerTarget, { childList: true, subtree: true });

    window.addEventListener('load', scheduleSync);
    document.addEventListener('readystatechange', scheduleSync);
    document.addEventListener('input', scheduleSync, true);
    document.addEventListener('change', scheduleSync, true);

    scheduleSync();
})();
