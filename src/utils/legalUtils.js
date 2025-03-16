// src/utils/legalUtils.js
function isLegalQuery(query) {
    const legalKeywords = [
      "law", "legal", "act", "section", "court", "constitution",
      "rights", "criminal", "civil", "contract", "divorce", "property",
      "injunction", "notice", "case", "litigation", "dispute", "judicial",
      "article", "accident", "injury", "traffic", "offence", "arrest",
      "bail", "sentence", "appeal", "petition", "writ", "hearing",
      "tribunal", "authority", "jurisdiction", "complaint", "plaintiff",
      "defendant", "litigants", "litigant", "legal", "lawyer", "advocate",
      "attorney", "counsel", "solicitor", "barrister", "judge", "justice",
      "court", "case", "trial", "appeal", "writ", "petition", "order",
      "judgment", "decree", "injunction", "hearing", "argument", "plea",
      "evidence", "proof", "document", "affidavit", "oath", "affirmation",
      "perjury", "witness", "deposition", "examination", "cross-examination",
      "testimony", "verdict", "sentence", "appeal", "petition", "complaint",
      "plaint", "evidence", "witness", "deposition", "affidavit",
      "oath", "affirmation", "perjury", "testimony", "examination",
      "deposition", "witness", "deposition", "evidence", "witness",
    ];
    const q = query.toLowerCase();
    return legalKeywords.some(keyword => new RegExp(`\\b${keyword}\\b`).test(q));
  }
  
  module.exports = {
    isLegalQuery
  };