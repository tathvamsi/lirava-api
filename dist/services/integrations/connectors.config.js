export const CONNECTOR_REGISTRY = [
    {
        id: "gmail",
        name: "Gmail",
        description: "Find and reference correspondence.",
        category: "Email",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        authMode: "preregistered",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    },
    {
        id: "google-drive",
        name: "Google Drive",
        description: "Locate files for a matter.",
        category: "Documents & Storage",
        url: "https://drivemcp.googleapis.com/mcp/v1",
        authMode: "preregistered",
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    },
    {
        id: "google-calendar",
        name: "Google Calendar",
        description: "Review upcoming dates and hearings.",
        category: "Calendar",
        url: "https://calendarmcp.googleapis.com/mcp/v1",
        authMode: "preregistered",
        scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    },
];
export const getConnector = (id) => CONNECTOR_REGISTRY.find((connector) => connector.id === id);
