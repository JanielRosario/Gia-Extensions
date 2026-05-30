// ==UserScript==
// @name         GWPC Property Tools for PolicyCenter
// @namespace    GPG_Scripts
// @version      1.0.2
// @description  Add Reconstruction Calculator, Zillow, and Google Maps buttons to PolicyCenter/Guidewire
// @match        https://policycenter.farmersinsurance.com/pc/PolicyCenter.do*
// @match        https://policycenter-2.farmersinsurance.com/pc/PolicyCenter.do*
// @match        https://policycenter-3.farmersinsurance.com/pc/PolicyCenter.do*
// @grant        none
// @author       Mr.G
// @updateURL    https://raw.githubusercontent.com/JanielRosario/GIA-TamperMonkey/main/STAFF%20scripts/GWPC/policycenter-gwpc-property-tools.user.js
// @downloadURL  https://raw.githubusercontent.com/JanielRosario/GIA-TamperMonkey/main/STAFF%20scripts/GWPC/policycenter-gwpc-property-tools.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SYNC_DELAY_MS = 75;

    const VALUE_INSURANCE_PACKAGE_EMAIL_BUTTON = {
        titleSelector: '.gw-TitleBar--title',
        titleText: 'Value Insurance Package',
        buttonSelector:
            '#SubmissionWizard-JobWizardToolsMenuWizardStepSet-MLI_Illustration_ExtScreen-actionableButtonDV-emailPkId',
        hiddenAttr: 'data-gpg-hidden-value-insurance-email',
        originalDisplayAttr: 'data-gpg-original-display'
    };

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

    const findMountTarget = (screenConfigs) => {
        for (const screenConfig of screenConfigs) {
            for (const selector of screenConfig.mountSelectors) {
                const element = document.querySelector(selector);
                if (element) {
                    return { screenConfig, element };
                }
            }
        }

        return null;
    };

    const removeStaleRoots = (rootAttr, target, isRootMountedOnTarget) => {
        document.querySelectorAll(`[${rootAttr}="true"]`).forEach((root) => {
            if (!isRootMountedOnTarget(root, target)) {
                root.remove();
            }
        });
    };

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

    const RECONSTRUCTION = {
        buttonClass: 'gpg-reconstruction-btn',
        rootAttr: 'data-gpg-reconstruction-root',
        screenAttr: 'data-gpg-screen-key',
        baseUrl: 'https://gomezagency.net/zipcodes.html',
        addressSelectors: {
            existingPolicy: [
                '#PolicyFileAccountFile_Summary-Summary_PolicyInfoDV-Address .gw-link.gw-label',
                '#PolicyFileAccountFile_Summary-Summary_PolicyInfoDV-Address .gw-value-readonly-wrapper',
                '[id*="Address"] .gw-link.gw-label',
                '[id*="Address"] .gw-value-readonly-wrapper'
            ],
            submission: [
                '.gw-RangeValue[data-gw-value^="PolicyLocation:"] .gw-link.gw-label',
                '.gw-link.gw-label[data-gw-click*="HODwellingLocationInput"]',
                '[data-gw-click*="HODwellingLocationInput"]',
                '[id^="SubmissionWizard"][id*="Address"] .gw-link.gw-label',
                '[id^="SubmissionWizard"][id*="Address"] .gw-value-readonly-wrapper',
                '[id^="SubmissionWizard"][id*="Address"] input',
                '[id^="SubmissionWizard"][id*="Location"] .gw-link.gw-label'
            ],
            policyChange: [
                '.gw-RangeValue[data-gw-value^="PolicyLocation:"] .gw-link.gw-label',
                '.gw-link.gw-label[data-gw-click*="HODwellingLocationInput"]',
                '[data-gw-click*="HODwellingLocationInput"]',
                '[id^="PolicyChangeWizard"][id*="Address"] .gw-link.gw-label',
                '[id^="PolicyChangeWizard"][id*="Address"] .gw-value-readonly-wrapper',
                '[id^="PolicyChangeWizard"][id*="Address"] input',
                '[id^="PolicyChangeWizard"][id*="Location"] .gw-link.gw-label'
            ],
            shared: [
                '[id*="Address"] .gw-link.gw-label',
                '[id*="Address"] .gw-value-readonly-wrapper',
                '[id*="Address"] input',
                '[id*="Location"] .gw-link.gw-label',
                '.gw-RangeValue[data-gw-value^="PolicyLocation:"] .gw-link.gw-label',
                '.gw-link.gw-label[data-gw-click*="HODwellingLocationInput"]',
                '[data-gw-click*="HODwellingLocationInput"]'
            ]
        },
        screenConfigs: [
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
                zipCodeFromAddressFirst: true,
                mountSelectors: [
                    '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-VRsikUpdateDV-0',
                    '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-VRiskUpdateDV-0'
                ],
                squareFootageSelectors: [
                    '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot_Input .gw-value-readonly-wrapper',
                    '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot .gw-value-readonly-wrapper',
                    '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot .gw-value',
                    '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot input[name*="ApproxSqFoot"]',
                    '#SubmissionWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot input',
                    '[id^="SubmissionWizard"][id*="ApproxSqFoot"] .gw-value-readonly-wrapper',
                    '[id^="SubmissionWizard"][id*="ApproxSqFoot"] .gw-value',
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
                zipCodeFromAddressFirst: true,
                mountSelectors: [
                    '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-VRsikUpdateDV-0',
                    '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-VRiskUpdateDV-0'
                ],
                squareFootageSelectors: [
                    '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot_Input .gw-value-readonly-wrapper',
                    '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot .gw-value-readonly-wrapper',
                    '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot .gw-value',
                    '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot input[name*="ApproxSqFoot"]',
                    '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-HODwellingConstructionDetailsHOEDV-ApproxSqFoot input',
                    '[id^="PolicyChangeWizard"][id*="ApproxSqFoot"] .gw-value-readonly-wrapper',
                    '[id^="PolicyChangeWizard"][id*="ApproxSqFoot"] .gw-value',
                    '[id^="PolicyChangeWizard"][id*="ApproxSqFoot"] input[name*="ApproxSqFoot"]',
                    '[id^="PolicyChangeWizard"][id*="ApproxSqFoot"] input'
                ],
                zipCodeSelectors: [
                    '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-PostalCode input',
                    '#PolicyChangeWizard-LOBWizardStepGroup-LineWizardStepSet-HODwellingHOEScreen-HODwellingConstructionSingleHOEPanelSet-PostalCode .gw-value-readonly-wrapper',
                    ...createZipSelectors('PolicyChangeWizard')
                ]
            }
        ]
    };

    const PROPERTY_LINKS = {
        buttonClass: 'gpg-property-link-button',
        rootAttr: 'data-gpg-property-links-root',
        screenAttr: 'data-gpg-property-links-screen',
        screenConfigs: [
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
        ],
        sharedAddressSelectors: [
            '[id*="Address"] .gw-link.gw-label',
            '[id*="Address"] .gw-value-readonly-wrapper',
            '[id*="Address"] input',
            '[id*="Location"] .gw-link.gw-label',
            '.gw-link.gw-label'
        ]
    };

    const scoreReconstructionAddressCandidate = (text, element) => {
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

    const findReconstructionAddress = (screenKey) => {
        const selectors = [
            ...(RECONSTRUCTION.addressSelectors[screenKey] || []),
            ...RECONSTRUCTION.addressSelectors.shared
        ];
        const candidates = uniqueElements(selectors);
        let best = null;

        candidates.forEach((element) => {
            const text = readElementValue(element);
            if (!text) {
                return;
            }

            const score = scoreReconstructionAddressCandidate(text, element);
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

    const findZipCodeFromAddress = (screenConfig) => {
        const addressCandidate = findReconstructionAddress(screenConfig.key);
        const addressTexts = collectAddressTexts(addressCandidate);

        for (const text of addressTexts) {
            const zipCode = normalizeZipCode(text);
            if (zipCode) {
                return zipCode;
            }
        }

        return '';
    };

    const findZipCode = (screenConfig) => {
        if (!screenConfig) {
            return '';
        }

        if (screenConfig.zipCodeFromAddressFirst) {
            const addressZipCode = findZipCodeFromAddress(screenConfig);
            if (addressZipCode) {
                return addressZipCode;
            }
        }

        const zipFieldCandidates = uniqueElements(screenConfig.zipCodeSelectors || []);
        for (const element of zipFieldCandidates) {
            const zipCode = normalizeZipCode(readElementValue(element));
            if (zipCode) {
                return zipCode;
            }
        }

        return findZipCodeFromAddress(screenConfig);
    };

    const buildReconstructionUrl = (screenConfig) => {
        const squareFootage = findSquareFootage(screenConfig);
        const zipCode = findZipCode(screenConfig);

        if (!zipCode || !squareFootage) {
            return null;
        }

        return `${RECONSTRUCTION.baseUrl}?zipcode=${encodeURIComponent(zipCode)}&squareFootage=${encodeURIComponent(
            squareFootage.value
        )}`;
    };

    const isReconstructionRootMountedOnTarget = (root, target) => {
        if (!root || !target || !target.element) {
            return false;
        }

        return target.element.contains(root);
    };

    const createReconstructionButton = (screenConfig) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = RECONSTRUCTION.buttonClass;
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

    const getExistingReconstructionRoot = (target) => {
        if (!target) {
            return null;
        }

        return Array.from(target.element.children).find(
            (child) =>
                child.getAttribute &&
                child.getAttribute(RECONSTRUCTION.rootAttr) === 'true' &&
                child.getAttribute(RECONSTRUCTION.screenAttr) === target.screenConfig.key
        ) || null;
    };

    const refreshReconstructionButtonState = (button, screenConfig) => {
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

    const ensureReconstructionButton = () => {
        const target = findMountTarget(RECONSTRUCTION.screenConfigs);
        if (!target) {
            return;
        }

        removeStaleRoots(RECONSTRUCTION.rootAttr, target, isReconstructionRootMountedOnTarget);

        let root = getExistingReconstructionRoot(target);
        if (!root) {
            root = document.createElement('div');
            root.setAttribute(RECONSTRUCTION.rootAttr, 'true');
            root.setAttribute(RECONSTRUCTION.screenAttr, target.screenConfig.key);
            root.style.display = 'block';

            const button = createReconstructionButton(target.screenConfig);
            root.appendChild(button);
            target.element.appendChild(root);
        }

        refreshReconstructionButtonState(root.querySelector(`.${RECONSTRUCTION.buttonClass}`), target.screenConfig);
    };

    const scorePropertyAddressCandidate = (text, element, mountElement) => {
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

    const findPropertyAddress = (screenConfig, mountElement) => {
        const selectors = [...screenConfig.addressSelectors, ...PROPERTY_LINKS.sharedAddressSelectors];
        const scopedCandidates = uniqueElements(selectors, mountElement);
        const globalCandidates = uniqueElements(selectors);
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

            const score = scorePropertyAddressCandidate(text, element, mountElement);
            if (!best || score > best.score) {
                best = { element, text, score };
            }
        });

        return best ? best.text : '';
    };

    const buildZillowUrl = (address) => `https://www.zillow.com/homes/${encodeURIComponent(address)}`;

    const buildGoogleMapsUrl = (address) =>
        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

    const isPropertyLinksRootMountedOnTarget = (root, target) => {
        if (!root || !target || !target.element) {
            return false;
        }

        return target.element.contains(root) && root.getAttribute(PROPERTY_LINKS.screenAttr) === target.screenConfig.key;
    };

    const createPropertyLinkButton = (text, color, getUrl) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = PROPERTY_LINKS.buttonClass;
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

    const getExistingPropertyLinksRoot = (target) => {
        if (!target) {
            return null;
        }

        return Array.from(target.element.children).find(
            (child) =>
                child.getAttribute &&
                child.getAttribute(PROPERTY_LINKS.rootAttr) === 'true' &&
                child.getAttribute(PROPERTY_LINKS.screenAttr) === target.screenConfig.key
        ) || null;
    };

    const refreshPropertyLinkButtonStates = (root, screenConfig, mountElement) => {
        if (!root) {
            return;
        }

        const address = findPropertyAddress(screenConfig, mountElement);
        const hasAddress = Boolean(address);

        root.querySelectorAll(`.${PROPERTY_LINKS.buttonClass}`).forEach((button) => {
            button.disabled = !hasAddress;
            button.style.opacity = hasAddress ? '1' : '0.65';
            button.style.cursor = hasAddress ? 'pointer' : 'not-allowed';
            button.title = hasAddress ? '' : 'Waiting for a valid address';
        });
    };

    const ensurePropertyLinkButtons = () => {
        const target = findMountTarget(PROPERTY_LINKS.screenConfigs);
        if (!target) {
            return;
        }

        removeStaleRoots(PROPERTY_LINKS.rootAttr, target, isPropertyLinksRootMountedOnTarget);

        let root = getExistingPropertyLinksRoot(target);
        if (!root) {
            root = document.createElement('div');
            root.setAttribute(PROPERTY_LINKS.rootAttr, 'true');
            root.setAttribute(PROPERTY_LINKS.screenAttr, target.screenConfig.key);
            root.style.display = 'flex';
            root.style.flexWrap = 'wrap';
            root.style.alignItems = 'center';

            const zillowButton = createPropertyLinkButton('Open in Zillow', '#0074cc', () => {
                const address = findPropertyAddress(target.screenConfig, target.element);
                return address ? buildZillowUrl(address) : '';
            });

            const mapsButton = createPropertyLinkButton('Open in Google Maps', '#34a853', () => {
                const address = findPropertyAddress(target.screenConfig, target.element);
                return address ? buildGoogleMapsUrl(address) : '';
            });

            root.appendChild(zillowButton);
            root.appendChild(mapsButton);
            target.element.appendChild(root);
        }

        refreshPropertyLinkButtonStates(root, target.screenConfig, target.element);
    };

    const isValueInsurancePackageScreen = () =>
        Array.from(document.querySelectorAll(VALUE_INSURANCE_PACKAGE_EMAIL_BUTTON.titleSelector)).some(
            (element) => normalizeAddress(readElementValue(element)) === VALUE_INSURANCE_PACKAGE_EMAIL_BUTTON.titleText
        );

    const syncValueInsurancePackageEmailButton = () => {
        const button = document.querySelector(VALUE_INSURANCE_PACKAGE_EMAIL_BUTTON.buttonSelector);
        if (!button) {
            return;
        }

        if (isValueInsurancePackageScreen()) {
            if (!button.hasAttribute(VALUE_INSURANCE_PACKAGE_EMAIL_BUTTON.hiddenAttr)) {
                button.setAttribute(
                    VALUE_INSURANCE_PACKAGE_EMAIL_BUTTON.originalDisplayAttr,
                    button.style.display || ''
                );
                button.setAttribute(VALUE_INSURANCE_PACKAGE_EMAIL_BUTTON.hiddenAttr, 'true');
            }

            button.style.display = 'none';
            return;
        }

        if (button.hasAttribute(VALUE_INSURANCE_PACKAGE_EMAIL_BUTTON.hiddenAttr)) {
            button.style.display = button.getAttribute(VALUE_INSURANCE_PACKAGE_EMAIL_BUTTON.originalDisplayAttr) || '';
            button.removeAttribute(VALUE_INSURANCE_PACKAGE_EMAIL_BUTTON.originalDisplayAttr);
            button.removeAttribute(VALUE_INSURANCE_PACKAGE_EMAIL_BUTTON.hiddenAttr);
        }
    };

    let syncScheduled = false;

    function scheduleSync() {
        if (syncScheduled) {
            return;
        }

        syncScheduled = true;

        window.setTimeout(() => {
            syncScheduled = false;
            ensureReconstructionButton();
            ensurePropertyLinkButtons();
            syncValueInsurancePackageEmailButton();
        }, SYNC_DELAY_MS);
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
