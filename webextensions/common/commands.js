/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

var gSelection = {
  tabs:         {},
  targetWindow: null
};

function clearSelection(aOptions = {}) {
  var tabs = [];
  for (let id of Object.keys(gSelection.tabs)) {
    tabs.push(gSelection.tabs[id]);
  }
  setSelection(tabs, false, aOptions);
  gSelection.targetWindow = null;
}

function isPermittedTab(aTab) {
  if (aTab.discarded)
    return false;
  return /^about:blank($|\?|#)/.test(aTab.url) ||
         !/^(about|resource|chrome|file|view-source):/.test(aTab.url);
}

function setSelection(aTabs, aSelected, aOptions = {}) {
  if (!Array.isArray(aTabs))
    aTabs = [aTabs];

  var shouldHighlight = aOptions.globalHighlight !== false;

  //console.log('setSelection ', ids, `${aState}=${aSelected}`);
  if (aSelected) {
    for (let tab of aTabs) {
      if (tab.id in gSelection.tabs)
        continue;
      gSelection.tabs[tab.id] = tab;
      if (shouldHighlight &&
          isPermittedTab(tab) &&
          !tab.pinned)
        Permissions.isGranted(Permissions.ALL_URLS).then(() => {
          browser.tabs.executeScript(tab.id, {
            code: `document.title = '✔' + document.title;`
          });
        });
    }
  }
  else {
    for (let tab of aTabs) {
      if (!(tab.id in gSelection.tabs))
        continue;
      delete gSelection.tabs[tab.id];
      if (shouldHighlight &&
          isPermittedTab(tab) &&
          !tab.pinned)
        Permissions.isGranted(Permissions.ALL_URLS).then(() => {
          browser.tabs.executeScript(tab.id, {
            code: `document.title = document.title.replace(/^✔/, '');`
          });
        });
    }
  }
  browser.runtime.sendMessage(kTST_ID, {
    type:  aSelected ? kTSTAPI_ADD_TAB_STATE : kTSTAPI_REMOVE_TAB_STATE,
    tabs:  aTabs.map(aTab => aTab.id),
    state: aOptions.states || aOptions.state || 'selected'
  }).catch(e => {}); // TST is not available
  window.onSelectionChange && onSelectionChange(aTabs, aSelected, aOptions);
}


function reservePushSelectionState() {
  if (reservePushSelectionState.reserved)
    clearTimeout(reservePushSelectionState.reserved);
  reservePushSelectionState.reserved = setTimeout(() => {
    pushSelectionState();
  }, 150);
}

async function pushSelectionState(aOptions = {}) {
  if (reservePushSelectionState.reserved) {
    clearTimeout(reservePushSelectionState.reserved);
    delete reservePushSelectionState.reserved;
  }
  await browser.runtime.sendMessage({
    type:          kCOMMAND_PUSH_SELECTION_INFO,
    selection:     gSelection,
    dragSelection: gDragSelection,
    updateMenu:    !!aOptions.updateMenu,
    contextTab:    aOptions.contextTab
  });
}


async function getAllTabs(aWindowId) {
  var tabs = aWindowId || gSelection.targetWindow ?
    await browser.tabs.query({ windowId: aWindowId || gSelection.targetWindow }) :
    (await browser.windows.getCurrent({ populate: true })).tabs ;
  return tabs.map(TabIdFixer.fixTab);
}

function getSelectedTabIds() {
  return Object.keys(gSelection.tabs).map(aId => parseInt(aId));
}

async function getAPITabSelection(aParams = {}) {
  var ids        = aParams.selectedIds || getSelectedTabIds();
  var selected   = [];
  var unselected = [];
  var tabs       = aParams.allTabs || await getAllTabs();
  for (let tab of tabs) {
    if (ids.indexOf(tab.id) < 0)
      unselected.push(tab);
    else
      selected.push(tab);
  }
  return { selected, unselected };
}


async function reloadTabs(aIds) {
  for (let id of aIds) {
    browser.tabs.reload(id);
  }
}

async function bookmarkTabs(aIds, aOptions = {}) {
  if (!(await Permissions.isGranted(Permissions.BOOKMARKS))) {
    notify({
      title:   browser.i18n.getMessage('notPermitted_bookmarks_title'),
      message: browser.i18n.getMessage('notPermitted_bookmarks_message')
    });
    return null;
  }

  var tabs = await Promise.all(aIds.map(aId => browser.tabs.get(aId)));
  tabs.forEach(TabIdFixer.fixTab);
  var folderParams = {
    title: browser.i18n.getMessage('bookmarkFolder_label', tabs[0].title)
  };
  if (aOptions.parentId) {
    folderParams.parentId = aOptions.parentId;
    if ('index' in aOptions)
      folderParams.index = aOptions.index;
  }
  var folder = await browser.bookmarks.create(folderParams);
  for (let i = 0, maxi = tabs.length; i < maxi; i++) {
    let tab = tabs[i];
    await browser.bookmarks.create({
      parentId: folder.id,
      index:    i,
      title:    tab.title,
      url:      tab.url
    });
  }

  browser.bookmarks.get(folder.parentId).then(aFolders => {
    notify({
      title:   browser.i18n.getMessage('bookmarkTabs_notification_title'),
      message: browser.i18n.getMessage('bookmarkTabs_notification_message', [
        tabs[0].title,
        tabs.length,
        aFolders[0].title
      ]),
      icon:    kNOTIFICATION_DEFAULT_ICON
    });
  });
  return folder;
}

async function duplicateTabs(aIds) {
  for (let id of aIds) {
    await browser.tabs.duplicate(id);
  }
}

async function pinTabs(aIds) {
  for (let id of aIds) {
    await browser.tabs.update(id, { pinned: true });
  }
}

async function unpinTabs(aIds) {
  for (let id of aIds) {
    await browser.tabs.update(id, { pinned: false });
  }
}

async function muteTabs(aIds) {
  for (let id of aIds) {
    browser.tabs.update(id, { muted: true });
  }
}

async function unmuteTabs(aIds) {
  for (let id of aIds) {
    browser.tabs.update(id, { muted: false });
  }
}

async function moveToWindow(aIds, aWindowId) {
  var structure = await browser.runtime.sendMessage(kTST_ID, {
    type: kTSTAPI_GET_TREE_STRUCTURE,
    tabs: aIds
  }).catch(e => {}); // TST is not available
  log('structure ', structure);
  var firstTab = aIds[0];
  var window;
  if (aWindowId) {
    window = await browser.windows.get(aWindowId);
  }
  else {
    window = await browser.windows.create({
      tabId: firstTab
    });
    aIds = aIds.slice(1);
  }
  await browser.runtime.sendMessage(kTST_ID, {
    type:   kTSTAPI_BLOCK_GROUPING,
    window: window.id
  }).catch(e => {}); // TST is not available
  var waitUntilCompletelyMoved = new Promise((aResolve, aReject) => {
    var restTabs = aIds.length - 1;
    var listener = (aTabId, aAttachInfo) => {
      restTabs--;
      if (restTabs <= 0) {
        browser.tabs.onAttached.removeListener(listener);
        aResolve();
      }
    };
    browser.tabs.onAttached.addListener(listener);
  });
  await Promise.all([
    safeMoveApiTabsAcrossWindows(aIds, {
      index:    1,
      windowId: window.id
    }),
    waitUntilCompletelyMoved
  ]);
  await browser.tabs.update(firstTab, { active: true });
  if (structure) {
    await wait(500); // wait until TST's initialization is finished
    await browser.runtime.sendMessage(kTST_ID, {
      type: kTSTAPI_SET_TREE_STRUCTURE,
      tabs: aIds,
      structure
    }).catch(e => {}); // TST is not available
  }
  await browser.runtime.sendMessage(kTST_ID, {
    type:   kTSTAPI_UNBLOCK_GROUPING,
    window: window.id
  }).catch(e => {}); // TST is not available
}

// workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1394477
async function safeMoveApiTabsAcrossWindows(aTabIds, aMoveOptions) {
  return (await Promise.all(aTabIds.map(async (aTabId, aIndex) => {
    try {
      var movedTab = await browser.tabs.move(aTabId, Object.assign({}, aMoveOptions, {
        index: aMoveOptions.index + aIndex
      }));
      if (Array.isArray(movedTab))
        movedTab = movedTab[0];
      return movedTab;
    }
    catch(e) {
      return null;
    }
  }))).filter(aTab => !!aTab);
}

async function removeTabs(aIds) {
  var tabs = await getAllTabs(); // because given ids are possibly unsorted.
  // close down to top, to keep tree structure of Tree Style Tab
  var ids = tabs.reverse().filter(aTab => aIds.indexOf(aTab.id) > -1).map(aTab => aTab.id);
  await browser.tabs.remove(ids);
}

async function removeOtherTabs(aIds) {
  var tabs = await getAllTabs(); // because given ids are possibly unsorted.
  // close down to top, to keep tree structure of Tree Style Tab
  var ids = tabs.reverse().filter(aTab => aIds.indexOf(aTab.id) < 0 && !aTab.pinned).map(aTab => aTab.id);
  await browser.tabs.remove(ids);
}

const kFORMAT_PARAMETER_MATCHER  = /\([^\)]+\)|\[[^\]]+\]|\{[^\}]+\}|<[^>]+>/g;
const kFORMAT_MATCHER_TST_INDENT = new RegExp(`%TST_INDENT(?:${kFORMAT_PARAMETER_MATCHER.source})*%`, 'gi');

async function copyToClipboard(aIds, aFormat) {
  if (!(await Permissions.isGranted(Permissions.CLIPBOARD_WRITE))) {
    notify({
      title:   browser.i18n.getMessage('notPermitted_clipboardWrite_title'),
      message: browser.i18n.getMessage('notPermitted_clipboardWrite_message')
    });
    return;
  }

  var allTabs = await getAllTabs();
  var tabs = allTabs.filter(aTab => aIds.indexOf(aTab.id) > -1);

  var indentLevels = [];
  if (kFORMAT_MATCHER_TST_INDENT.test(aFormat)) {
    try {
      const tabsWithChildren = await browser.runtime.sendMessage(kTST_ID, {
        type: 'get-tree',
        tabs: tabs.map(aTab => aTab.id)
      });
      const ancestorsOf = {};
      const collectAncestors = (aTab) => {
        ancestorsOf[aTab.id] = ancestorsOf[aTab.id] || [];
        for (let child of aTab.children) {
          collectAncestors(child);
          ancestorsOf[child.id] = [aTab.id].concat(ancestorsOf[aTab.id]);
        }
      };
      for (let tab of tabsWithChildren) {
        collectAncestors(tab);
      }
      // ignore indent information for partial selection
      indentLevels = tabsWithChildren.map(aTab => {
        return ancestorsOf[aTab.id].filter(aAncestorId => aIds.indexOf(aAncestorId) > -1).length
      });
    }
    catch(e) {
    }
  }

  var lineFeed = configs.useCRLF ? '\r\n' : '\n' ;
  var itemsToCopy = await Promise.all(tabs.map((aTab, aIndex) => fillPlaceHolders(aFormat, aTab, indentLevels[aIndex])));

  var richText = /%RT%/i.test(aFormat) ? itemsToCopy.map(aItem => aItem.richText).join('<br />') : null ;
  var plainText = itemsToCopy.map(aItem => aItem.plainText).join(lineFeed);
  if (tabs.length > 1)
    plainText += lineFeed;

  log('richText: ', richText);
  log('plainText: ', plainText);

  var doCopy = function() {
    if (richText) {
      // This block won't work if dom.event.clipboardevents.enabled=false.
      // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1396275
      document.addEventListener('copy', aEvent => {
        aEvent.stopImmediatePropagation();
        aEvent.preventDefault();
        aEvent.clipboardData.setData('text/plain', plainText);
        aEvent.clipboardData.setData('text/html',  richText);
      }, {
        once:    true,
        capture: true
      });
      document.execCommand('copy');
    }
    else {
      // this is still required to block overriding clipboard data from scripts of the webpage.
      document.addEventListener('copy', aEvent => {
        aEvent.stopImmediatePropagation();
        aEvent.preventDefault();
        aEvent.clipboardData.setData('text/plain', plainText);
      }, {
        capture: true,
        once: true
      });
      let field = document.createElement('textarea');
      field.setAttribute('style', 'position:fixed; top:0; left:0; opacity:0');
      field.value = plainText;
      document.body.appendChild(field);
      field.focus();
      field.select();
      document.execCommand('copy');
      field.parentNode.removeChild(field);
    }
  };

  if (!configs.useWorkaroundForBug1272869) {
    doCopy();
    return;
  }

  var permittedTabs = tabs.filter(isPermittedTab);
  if (permittedTabs.length == 0) {
    permittedTabs = allTabs.filter(isPermittedTab);
    if (permittedTabs.length == 0)
      throw new Error('no permitted tab to copy data to the clipboard');
  }
  browser.tabs.executeScript(permittedTabs[0].id, {
    /* Due to Firefox's limitation, we cannot copy text from background script.
       Moreover, when this command is called from context menu on a tab,
       there is no browser_action page.
       Thus we need to embed text field into webpage and execute a command to copy,
       but scripts in the webpage can steal the data - that's crazy and dangerous!
       See also:
        https://developer.mozilla.org/en-US/Add-ons/WebExtensions/Interact_with_the_clipboard#Browser-specific_considerations
        https://bugzilla.mozilla.org/show_bug.cgi?id=1272869
        https://bugzilla.mozilla.org/show_bug.cgi?id=1344410
    */
    code: `
      {
        let richText = ${JSON.stringify(richText)};
        let plainText = ${JSON.stringify(plainText)};
        (${doCopy.toString()})();
      }
    `
  });
}

async function fillPlaceHolders(aFormat, aTab, aIndentLevel) {
  log('fillPlaceHolders ', aTab.id, aFormat, aIndentLevel);
  var lineFeed = configs.useCRLF ? '\r\n' : '\n' ;
  var contentsData = {};
  if (!aTab.discarded &&
      isPermittedTab(aTab) &&
      /%(AUTHOR|DESC(?:RIPTION)?|KEYWORDS)(?:_HTML(?:IFIED)?)?%/i.test(aFormat)) {
    log('trying to get data from content ', aTab.id);
    contentsData = await browser.tabs.executeScript(aTab.id, {
      file: '/common/get-content-text.js'
    });
    if (Array.isArray(contentsData))
      contentsData = contentsData[0];
    log('contentsData ', contentsData);
  }
  var now = new Date();
  var timeUTC = now.toUTCString();
  var timeLocal = now.toLocaleString();
  var formatted = aFormat
    .replace(/%(?:RLINK|RLINK_HTML(?:IFIED)?|SEL|SEL_HTML(?:IFIED)?)%/gi, '')
    .replace(/%URL%/gi, aTab.url)
    .replace(/%(?:TITLE|TEXT)%/gi, aTab.title)
    .replace(/%URL_HTML(?:IFIED)?%/gi, sanitizeHtmlText(aTab.url))
    .replace(/%TITLE_HTML(?:IFIED)?%/gi, sanitizeHtmlText(aTab.title))
    .replace(/%AUTHOR%/gi, contentsData.author || '')
    .replace(/%AUTHOR_HTML(?:IFIED)?%/gi, sanitizeHtmlText(contentsData.author || ''))
    .replace(/%DESC(?:RIPTION)?%/gi, contentsData.description || '')
    .replace(/%DESC(?:RIPTION)?_HTML(?:IFIED)?%/gi, sanitizeHtmlText(contentsData.description || ''))
    .replace(/%KEYWORDS%/gi, contentsData.keywords || '')
    .replace(/%KEYWORDS_HTML(?:IFIED)?%/gi, sanitizeHtmlText(contentsData.keywords || ''))
    .replace(/%UTC_TIME%/gi, timeUTC)
    .replace(/%LOCAL_TIME%/gi, timeLocal)
    .replace(/%TAB%/gi, '\t')
    .replace(/%EOL%/gi, lineFeed)
    .replace(/%RT%/gi, '')
    .replace(kFORMAT_MATCHER_TST_INDENT, aMatched => {
      let indenters = aMatched.replace(/^%TST_INDENT|%$/g, '');
      if (indenters == '') {
        indenters = ['  '];
      }
      else {
        indenters = indenters
          .match(kFORMAT_PARAMETER_MATCHER)
          .map(aIndenter => aIndenter.substring(1, aIndenter.length - 1))
          .reverse();
      }
      let indent = '';
      for (let i = 0; i < aIndentLevel; i++) {
        let indenter = indenters[Math.min(i, indenters.length - 1)];
        indent = `${indenter}${indent}`;
      }
      return indent;
    });

  if (/%RT%/i.test(aFormat)) {
    return {
      richText:  formatted.trim() && formatted ||
                   `<a href="${sanitizeHtmlText(aTab.url)}">${sanitizeHtmlText(aTab.title)}</a>`,
      plainText: formatted.trim() && formatted ||
                   `${aTab.title}<${aTab.url}>`
    };
  }
  return {
    richText:  '',
    plainText: formatted
  };
}

function sanitizeHtmlText(aText) {
  return aText
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function saveTabs(aIds) {
  var tabs = await getAllTabs();
  var prefix = configs.saveTabsPrefix;
  prefix = `${prefix.replace(/\/$/, '')}/`;
  for (let tab of tabs) {
    if (aIds.indexOf(tab.id) > -1)
      browser.downloads.download({
        url:      tab.url,
        filename: `${prefix}${await suggestFileNameForTab(tab)}`
      });
  }
}

const kMAYBE_IMAGE_PATTERN    = /\.(jpe?g|png|gif|bmp|svg)/i;
const kMAYBE_RAW_FILE_PATTERN = /\.(te?xt|md)/i;

async function suggestFileNameForTab(aTab) {
  var fileNameMatch = aTab.url
    .replace(/^\w+:\/\/[^\/]+\//, '') // remove origin part
    .replace(/#.*$/, '') // remove fragment
    .replace(/\?.*$/, '') // remove query
    .match(/([^\/]+\.([^\.\/]+))$/);
  log('suggestFileNameForTab ', aTab.id, fileNameMatch);
  if (fileNameMatch &&
      (kMAYBE_IMAGE_PATTERN.test(fileNameMatch[1]) ||
       kMAYBE_RAW_FILE_PATTERN.test(fileNameMatch[1])))
    return fileNameMatch[1];

  var suggestedExtension = '';
  if (!aTab.discarded &&
      isPermittedTab(aTab)) {
    log(`getting content type of ${aTab.id}`);
    if (!(await Permissions.isGranted(Permissions.ALL_URLS))) {
      notify({
        title:   browser.i18n.getMessage('notPermitted_allUrls_title'),
        message: browser.i18n.getMessage('notPermitted_allUrls_message')
      });
    }
    else {
      let contentType = await browser.tabs.executeScript(aTab.id, {
        code: `document.contentType`
      });
      if (Array.isArray(contentType))
        contentType = contentType[0];
      log(`contentType of ${aTab.id}: `, contentType);
      if (/^(text\/html|application\/xhtml\+xml)/.test(contentType)) {
        suggestedExtension = '.html';
      }
      else if (/^text\//.test(contentType)) {
        suggestedExtension = '.txt';
      }
      else if (/^image\//.test(contentType)) {
        suggestedExtension = `.${contentType.replace(/^image\/|\+.+$/g, '')}`;
      }
    }
  }
  log('suggestedExtension: ', aTab.id, suggestedExtension);
  var fileName = `${aTab.title.replace(/[\/\\:*?"<>|]/g, '_')}${suggestedExtension}`;
  log('finally suggested fileName: ', aTab.id, fileName);
  return fileName;
}

async function suspendTabs(aIds, aOptions = {}) {
  if (typeof browser.tabs.discard != 'function')
    throw new Error('Error: required API "tabs.discard()" is not available on this version of Firefox.');
  const allTabs = await browser.tabs.query({ windowId: gSelection.targetWindow });
  let inSelection = false;
  let selectionFound = false;
  let unselectedTabs = [];
  let nextFocusedTab = null;
  for (let tab of allTabs) {
    if (tab.active && aIds.indexOf(tab.id) < 0) {
      nextFocusedTab = null;
      unselectedTabs = [];
      break;
    }
    if (!inSelection && aIds.indexOf(tab.id) > -1) {
      inSelection = true;
      selectionFound = true;
    }
    else if (inSelection && aIds.indexOf(tab.id) < 0) {
      inSelection = false;
    }
    if (selectionFound && !inSelection && !tab.discarded) {
      nextFocusedTab = tab;
      break;
    }
    if (!inSelection && !selectionFound)
      unselectedTabs.push(tab);
  }
  if (!nextFocusedTab && unselectedTabs.length > 0) {
    for (let tab of unselectedTabs.reverse()) {
      if (tab.discarded)
        continue;
      nextFocusedTab = tab;
      break;
    }
  }
  if (nextFocusedTab)
    await browser.tabs.update(nextFocusedTab.id, { active: true });
  return browser.tabs.discard(aIds);
}

async function resumeTabs(aIds) {
  const allTabs = (await browser.tabs.query({ windowId: gSelection.targetWindow }));
  const activeTab = allTabs.filter(aTab => aTab.active)[0];
  const selectedTabs = allTabs.filter(aTab => aIds.indexOf(aTab.id) > -1);
  for (let tab of selectedTabs) {
    //if (tab.discarded)
    await browser.tabs.update(tab.id, { active: true });
  }
  return browser.tabs.update(activeTab.id, { active: true });
}

async function selectAllTabs() {
  var tabs = await getAllTabs();
  setSelection(tabs, true);
}

async function invertSelection() {
  var tabs = await getAllTabs();
  var selectedIds = getSelectedTabIds();
  var newSelected = [];
  var oldSelected = [];
  for (let tab of tabs) {
    let toBeSelected = selectedIds.indexOf(tab.id) < 0;
    if (toBeSelected)
      newSelected.push(tab);
    else
      oldSelected.push(tab);
  }
  setSelection(oldSelected, false);
  setSelection(newSelected, true);
}
