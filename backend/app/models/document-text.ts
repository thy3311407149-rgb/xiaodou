export type DocumentText = {
  id: string
  fileId: string
  pageNumber: number
  content: string
  createdAt: string
}

export type CreateDocumentTextInput = {
  id: string
  fileId: string
  pageNumber: number
  content: string
}
