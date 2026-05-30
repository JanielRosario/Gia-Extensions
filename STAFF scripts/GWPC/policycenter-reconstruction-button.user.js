// ==UserScript==
// @name         Reconstruction Calculator Button for PolicyCenter
// @namespace    GPG_Scripts
// @version      5.1
// @description  Add one Reconstruction Calculator button that works on existing-policy, quoting, and policy-change screens in PolicyCenter
// @match        https://policycenter.farmersinsurance.com/pc/PolicyCenter.do*
// @match        https://policycenter-2.farmersinsurance.com/pc/PolicyCenter.do*
// @match        https://policycenter-3.farmersinsurance.com/pc/PolicyCenter.do*
// @grant        none
// @author       Mr.G
// @updateURL    https://raw.githubusercontent.com/ugomez809/GIA-TamperMonkey/main/GWPC-Reconstruction-Button/policycenter-reconstruction-button.user.js
// @downloadURL  https://raw.githubusercontent.com/ugomez809/GIA-TamperMonkey/main/GWPC-Reconstruction-Button/policycenter-reconstruction-button.user.js
// ==/UserScript==

(function () {
    'use strict';

    const BUTTON_CLASS = 'gpg-reconstruction-btn';
    const ROOT_ATTR = 'data-gpg-reconstruction-root';
    const SCREEN_ATTR = 'data-gpg-screen-key';
    const RECONSTRUCTION_BASE_URL = 'https://gomezagency.net/zipcodes.html';

    const createZipSelectors = (prefix) => [
        `[id^="${prefix}"][id*="PostalCode"] input[name*="PostalCode"]`,
        `[id^="${prefix}"][id*="PostalCode"] input`,
        `[id^="${prefix}"][id*="PostalCode"] .gw-value-readonly-wrapper`,
        `[id^="${prefix}"][id*="PostalCode"] .gw-value`,
        `[id^="${prefix}"][id*="Zip"] input[name*="Zip"]`,
        `[id^="${prefix}"][id*="Zip"] input`,
        `[id^="${prefix}"][id*="Zip"] .gw-value-readonly-wrapper`,
        `[id^="${prefix}"][id*="Zip"] .gw-value`,
        `input[id^="${prefix}"][name*="PostalCode"]`,
        `input[id^="${prefix}"][name*="Zip"]`
    ];

    const ADDRESS_SELECTORS = {
        existingPolicy: [
            '#PolicyFileAccountFile_Summary-Summary_PolicyInfoDV-Address .gw-link.gw-label',
            '#PolicyFileAccountFile_Summary-Summary_PolicyInfoDV-Address .gw-value-readonly-wrapper',
            '[id*="Address"] .gw-link.gw-label',
            '[id*="Address"] .gw-value-readonly-wrapper'
        ],
        submission: [
            '[id^="SubmissionWizard"][id*="Address"] .gw-link.gw-label',
            '[id^="SubmissionWizard"][id*="Address"] .gw-value-readonly-wrapper',
            '[id^="SubmissionWizard"][id*="Address"] input',
            '[id^="SubmissionWizard"][id*="Location"] .gw-link.gw-label'
        ],
        policyChange: [
            '[id^="PolicyChangeWizard"][id*="Address"] .gw-link.gw-label',
            '[id^="PolicyChangeWizard"][id*="Address"] .gw-value-readonly-wrapper',
            '[id^="PolicyChangeWizard"][id*="Address"] input',
            '[id^="PolicyChangeWizard"][id*="Location"] .gw-link.gw-label'
        ],
        shared: [
            '[id*="Address"] .gw-link.gw-label',
            '[id*="Address"] .gw-value-readonly-wrapper',
            '[id*="Address"] input',
            '[id*="Location"] .gw-link.gw-label'
        ]
    };

    const SCREEN_CONFIGS = [
        {
            key: 'existingPolicy',
            mountSelectors: ['#PolicyFileDwellingHOE-PolicyFile_Homeowners_Dwelling_Screen-7'],
            squareFootageSelectors: [
                '#PolicyFileDwellingHOE-PolicyFile_Homeowners_Dwelling_Screen-HODwellingConstructionDetailsHOEDV-ApproxSqFoot .gw-value-readonly-wrapper',
                '#PolicyFileDwellingHOE-PolicyFile_Homeowners_Dwelling_Screen-HODwellingConstructionDetailsHOEDV-ApproxSqFoot .gw-value',
                '#PolicyFileDwellingHOE-PolicyFile_Homeowners_Dwelling_Screen-HODwellingConstructionDetailsHOEDV-ApproxSqFoot input'
            ],
            zipCodeSelectors: [
                '#PolicyFileAccountFile_Summary-Summary_PolicyInfoDV-PostalCode input',
                '#PolicyFileAccountFile_Summary-Summary_PolicyInfoDV-PostalCode .gw-value-readonly-wrapper',
                ...createZipSelectors('PolicyFile')
            ]
        },
        {
            key: 'submission',
            mountSelectors: [
                '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-VRsikUpdateDV-0',
                '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-VRiskUpdateDV-0'
            ],
            squareFootageSelectors: [
                '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot input[name*="ApproxSqFoot"]',
                '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot input',
                '[id^="SubmissionWizard"][id*="ApproxSqFoot"] input[name*="ApproxSqFoot"]',
                '[id^="SubmissionWizard"][id*="ApproxSqFoot"] input'
            ],
            zipCodeSelectors: [
                '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-PostalCode input',
                '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-PostalCode .gw-value-readonly-wrapper',
                ...createZipSelectors('SubmissionWizard')
            ]
        },
        {
            key: 'policyChange',
            mountSelectors: [
                '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-VRsikUpdateDV-0',
                '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-VRiskUpdateDV-0'
            ],
            squareFootageSelectors: [
                '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot input[name*="ApproxSqFoot"]',
                '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot input',
                '[id^="PolicyChangeWizard"][id*="ApproxSqFoot"] input[name*="ApproxSqFoot"]',
                '[id^="PolicyChangeWizard"][id*="ApproxSqFoot"] input'
            ],
            zipCodeSelectors: [
                '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-PostalCode input',
                '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-PostalCode .gw-value-readonly-wrapper',
                ...createZipSelectors('PolicyChangeWizard')
            ]
        }
    ];

    const uniqueElements = (selectors) => {
        const seen = new Set();
        const results = [];

        selectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((element) => {
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

    const scoreAddressCandidate = (text, element) => {
        let score = 0;

        if (/\bCA\s+(\d{5})(?:-\d{4})?\b/i.test(text)) {
            score += 10;
        } else if (/\b\d{5}(?:-\d{4})?\b/.test(text)) {
            score += 6;
        }

        if (text.includes(',')) {
            score += 2;
        }

        if (element.closest('[id*="Address"], [id*="Location"]')) {
            score += 4;
        }

        if (element.matches('.gw-link.gw-label')) {
            score += 1;
        }

        return score;
    };

    const findAddress = (screenKey) => {
        const selectors = [
            ...(ADDRESS_SELECTORS[screenKey] || []),
            ...ADDRESS_SELECTORS.shared
        ];
        const candidates = uniqueElements(selectors);
        let best = null;

        candidates.forEach((element) => {
            const text = readElementValue(element);
            if (!text) {
                return;
            }

            const score = scoreAddressCandidate(text, element);
            if (!best || score > best.score) {
                best = { element, text, score };
            }
        });

        return best;
    };

    const normalizeSquareFootage = (value) => {
        const cleaned = value.replace(/,/g, '').trim();
        if (!cleaned) {
            return '';
        }

        const numericMatch = cleaned.match(/\d+(?:\.\d+)?/);
        return numericMatch ? numericMatch[0] : '';
    };

    const findSquareFootage = (screenConfig) => {
        if (!screenConfig) {
            return null;
        }

        const candidates = uniqueElements(screenConfig.squareFootageSelectors);

        for (const element of candidates) {
            const rawValue = readElementValue(element);
            const normalizedValue = normalizeSquareFootage(rawValue);

            if (normalizedValue) {
                return {
                    element,
                    rawValue,
                    value: normalizedValue
                };
            }
        }

        return null;
    };

    const normalizeZipCode = (value) => {
        if (!value) {
            return '';
        }

        const caMatch = value.match(/\bCA\s+(\d{5})(?:-\d{4})?\b/i);
        if (caMatch) {
            return caMatch[1];
        }

        const zipMatches = value.match(/\b\d{5}(?:-\d{4})?\b/g);
        if (!zipMatches || zipMatches.length === 0) {
            return '';
        }

        return zipMatches[zipMatches.length - 1].slice(0, 5);
    };

    const collectAddressTexts = (addressCandidate) => {
        if (!addressCandidate || !addressCandidate.element) {
            return [];
        }

        const texts = [];
        const seen = new Set();
        const containers = [
            addressCandidate.element,
            addressCandidate.element.closest('[id*="Address"]'),
            addressCandidate.element.closest('[id*="Location"]'),
            addressCandidate.element.closest('.gw-ValueWidget'),
            addressCandidate.element.closest('.gw-InputWidget'),
            addressCandidate.element.parentElement
        ];

        containers.forEach((element) => {
            if (!element) {
                return;
            }

            const text = readElementValue(element);
            if (text && !seen.has(text)) {
                seen.add(text);
                texts.push(text);
            }

            const contentText = (element.textContent || '').trim();
            if (contentText && !seen.has(contentText)) {
                seen.add(contentText);
                texts.push(contentText);
            }
        });

        return texts;
    };

    const findZipCode = (screenConfig) => {
        if (!screenConfig) {
            return '';
        }

        const zipFieldCandidates = uniqueElements(screenConfig.zipCodeSelectors || []);
        for (const element of zipFieldCandidates) {
            const zipCode = normalizeZipCode(readElementValue(element));
            if (zipCode) {
                return zipCode;
            }
        }

        const addressCandidate = findAddress(screenConfig.key);
        const addressTexts = collectAddressTexts(addressCandidate);

        for (const text of addressTexts) {
            const zipCode = normalizeZipCode(text);
            if (zipCode) {
                return zipCode;
            }
        }

        return '';
    };

    const buildReconstructionUrl = (screenConfig) => {
        const squareFootage = findSquareFootage(screenConfig);
        const zipCode = findZipCode(screenConfig);

        if (!zipCode || !squareFootage) {
            return null;
        }

        return `${RECONSTRUCTION_BASE_URL}?zipcode=${encodeURIComponent(zipCode)}&squareFootage=${encodeURIComponent(
            squareFootage.value
        )}`;
    };

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

        return target.element.contains(root);
    };

    const removeStaleRoots = (target) => {
        document.querySelectorAll(`[${ROOT_ATTR}="true"]`).forEach((root) => {
            if (!isRootMountedOnTarget(root, target)) {
                root.remove();
            }
        });
    };

    const createButton = (screenConfig) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = BUTTON_CLASS;
        button.textContent = 'Reconstruction Calculator';

        Object.assign(button.style, {
            margin: '10px 0',
            padding: '5px 10px',
            cursor: 'pointer',
            backgroundColor: '#ff8c00',
            color: '#fff',
            border: 'none',
            borderRadius: '4px'
        });

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            const reconstructionUrl = buildReconstructionUrl(screenConfig);
            if (!reconstructionUrl) {
                scheduleSync();
                return;
            }

            window.open(reconstructionUrl, '_blank', 'noopener');
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

    const refreshButtonState = (button, screenConfig) => {
        if (!button) {
            return;
        }

        const hasUrl = Boolean(buildReconstructionUrl(screenConfig));
        button.disabled = !hasUrl;
        button.style.opacity = hasUrl ? '1' : '0.65';
        button.style.cursor = hasUrl ? 'pointer' : 'not-allowed';
        button.title = hasUrl
            ? 'Open the Reconstruction Calculator'
            : 'Waiting for a valid address and square footage';
    };

    const ensureButton = () => {
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
            root.style.display = 'block';

            const button = createButton(target.screenConfig);
            root.appendChild(button);
            target.element.appendChild(root);
        }

        refreshButtonState(root.querySelector(`.${BUTTON_CLASS}`), target.screenConfig);
    };

    let syncScheduled = false;

    function scheduleSync() {
        if (syncScheduled) {
            return;
        }

        syncScheduled = true;

        window.setTimeout(() => {
            syncScheduled = false;
            ensureButton();
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
