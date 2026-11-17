export type Attachment = {
  name: string;
  mime: string;
  dataUrl: string;
};

export type OfficeRequest = {
  id: string;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  createdAt: number;
  replyTo: string | null;
  attachments: Attachment[];
  pinned: boolean;
  archived: boolean;
  viewed: boolean;
  syncState: "queued" | "server" | "received";
};

export type NewRequest = {
  recipient: string;
  subject: string;
  body: string;
  replyTo: string | null;
  attachments: Attachment[];
};

export type NetStatus = {
  mode: "offline" | "host" | "client";
  address: string;
  port: number;
};