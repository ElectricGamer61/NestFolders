# Privacy Policy — NestFolders
Last updated: August 14th 2026

## 1. Introduction
NestFolders (“the Extension”) is a Chrome browser extension that allows users to organise their ChatGPT and Claude conversations into nested folders.  
This Privacy Policy explains what data the Extension stores, how it is used, and what it does not collect.

The Extension is designed with privacy as a core principle.
<br><br>

## 2. Information the Extension Stores

The Extension stores only the minimal data required to provide folder organisation.  
All stored data is kept inside `chrome.storage.sync`, allowing your folder structure to sync across devices logged into your Google account.

### 2.1 Global Settings

These are simple UI preference values such as:

- folder icon style
- whether the sidebar resize handle is shown, and the sidebar width (ChatGPT only)

Example:
`{
  "settings": {
    "folderIconStyle": "fill"
  }
}
`

These settings contain no personal information.

### 2.2 Folder Layout & Chat Associations

The Extension saves the folder structure you create, including:

- folder names
- folder colours
- expanded/collapsed states
- nested folder hierarchy
- conversation IDs and the conversation title shown in the sidebar - see below:

Conversation IDs (`/c/xxxxxxxx` on ChatGPT, `/chat/xxxxxxxx` on Claude) do not reveal chat content and are used solely to associate chats with folders.

The Extension also stores the conversation **title exactly as the app already displays it in your sidebar**, truncated to 120 characters. This is required so that a chat filed in a folder can still be listed there after the app stops showing it in its recent conversations - Claude lists only recent chats, and ChatGPT pages its history. The title is read from the sidebar link only; the Extension never opens, requests, or reads a conversation.

ChatGPT and Claude layouts are stored under separate key namespaces, so the two apps' folders never mix.

Example:

`{  
  "layout": {  
    "items": [  
      {  
        "id": "folder-1",  
        "name": "Parent",  
        "type": "folder",
        "expanded": true,
        "color": "#009dff",
        "children": [
          { "id": "/c/xxxxxx", "type": "chat", "title": "Roadmap planning" },
          {
            "id": "folder-2",
            "name": "Child 1",
            "type": "folder",
            "children": [
              { "id": "/c/yyyyyy", "type": "chat", "title": "Bug triage" }
            ]
          }
        ]
      }
    ]
  }
}`

The Extension does not access, download, or analyse conversation text.
<br><br>

## 3. Information the Extension Does Not Collect
The Extension does not collect, store, transmit, or analyse:
- Any ChatGPT or Claude message content
- Anything you type into ChatGPT or Claude
- Personal information or account details
- Cookies or authentication tokens
- Browser history
- IP addresses
- Analytics or tracking data
<br><br>

## 4. Data Transmission
The Extension does not transmit any data externally.  
No external servers  
No analytics  
No telemetry  
No third-party data sharing  
No advertising  
All stored data remains within Chrome’s sync storage.
<br><br>

## 5. Permissions
The Extension uses the following Chrome permissions:  
`storage`  
(Required to save folder structure and user settings).

`tabs`  
(Required so the popup can send commands - such as “create folder” - to the ChatGPT or Claude tab you are viewing).

Host permissions (`https://chatgpt.com/*` and `https://claude.ai/*`)  
Used exclusively to insert the folder UI into those pages.  
The Extension does not access message content or modify network requests.  
<br><br>

## 6. Data Export
The Extension provides a feature allowing users to download and review all of their stored data.
<br><br>


## 7. Data Deletion
Users may remove all stored data at any time by:
- uninstalling the extension
- clearing Chrome sync data
- manually deleting the extension’s storage via Chrome settings

No data remains after removal.
<br><br>

## 8. Changes to This Policy
If the Extension’s behaviour changes in a way that affects stored data, this Privacy Policy will be updated.
The revision date at the top will reflect the most recent version.
<br><br>

## 9. Contact
For questions, feature suggestions, or privacy concerns, please submit an issue via:
https://github.com/ElectricGamer61/NestFolders/issues
