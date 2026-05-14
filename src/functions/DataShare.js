const path = require("path");
const fs = require("fs").promises; // Using the promise-based fs module
const Logger = require("../utils/Logger");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Database = require("../utils/Database");

const logger = new Logger("data-share");
const database = Database.getInstance();

/*

Pra mandar dados do grupo pra fora.
Exemplo de função no google sheets:

function fetchDataRavena(groupId, variable, startCell) {
  // Validate inputs
  if (!groupId || !variable || !startCell) {
    SpreadsheetApp.getUi().alert("Error", "Please provide groupId, variable, and startCell.", SpreadsheetApp.getUi().ButtonSet.OK);
    return "Error: Missing parameters.";
  }

  const url = `https://ravena.moothz.win/getData/${encodeURIComponent(groupId)}/${encodeURIComponent(variable)}`;
  let sheet;
  let startRow;
  let startCol;

  try {
    // Determine the sheet and cell coordinates
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let range;
    if (startCell.includes("!")) {
      range = ss.getRange(startCell);
      sheet = range.getSheet();
    } else {
      sheet = ss.getActiveSheet();
      range = sheet.getRange(startCell);
    }
    startRow = range.getRow();
    startCol = range.getColumn();

    // Make the HTTP GET request
    const options = {
      'method': 'get',
      'contentType': 'application/json',
      'muteHttpExceptions': true // Important to catch HTTP errors gracefully
    };
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    const responseBody = response.getContentText();

    if (responseCode === 200) {
      const jsonResponse = JSON.parse(responseBody);
      const dataToPlace = jsonResponse.dados; // Assuming your API returns { "dados": "some_value", "restantes": N }

      if (dataToPlace === null || dataToPlace === undefined) {
        sheet.getRange(startRow, startCol).setValue(''); // Clear the cell or set empty if data is null/undefined
        return "Data was null or undefined; cell cleared.";
      }

      // Check if dataToPlace is a string and contains commas (potential CSV)
      if (typeof dataToPlace === 'string' && dataToPlace.includes(',')) {
        const values = dataToPlace.split(',').map(item => item.trim()); // Split and trim whitespace
        // Prepare a 2D array for setValues: [[val1, val2, val3]]
        const rowData = [values];
        const targetRange = sheet.getRange(startRow, startCol, 1, values.length);
        targetRange.setValues(rowData);
        return `CSV data placed starting at ${startCell}. Items: ${values.length}.`;
      } else {
        // Not CSV or not a string, place directly
        sheet.getRange(startRow, startCol).setValue(dataToPlace);
        return `Data placed in ${startCell}.`;
      }
    } else if (responseCode === 404) {
      const errorResponse = JSON.parse(responseBody);
      Logger.log(`Error ${responseCode}: ${errorResponse.erro || responseBody}`);
      sheet.getRange(startRow, startCol).setValue(`Error: ${errorResponse.erro || 'Data not found'}`);
      return `Error: ${errorResponse.erro || 'Data not found'}`;
    } else {
      Logger.log(`Error ${responseCode}: ${responseBody}`);
      sheet.getRange(startRow, startCol).setValue(`HTTP Error ${responseCode}`);
      return `HTTP Error ${responseCode}: ${responseBody}`;
    }
  } catch (e) {
    Logger.log(`Exception: ${e.toString()}\nStack: ${e.stack}`);
    // Attempt to write error to cell if sheet and startCell were resolved
    if (sheet && startRow && startCol) {
      try {
        sheet.getRange(startRow, startCol).setValue(`Script Error: ${e.message}`);
      } catch (innerErr) {
        Logger.log(`Could not write error to cell: ${innerErr.toString()}`);
      }
    }
    return `Script Error: ${e.message}`;
  }
}

function testFetchDataRavena() {
  // Example usage:
  // Replace 'yourGroupId@g.us', 'yourVariable', and 'Sheet1!A1' with actual test values.
  const groupId = "testgroup@g.us"; // Example groupId
  const variable = "frutas";       // Example variable that might return "banana,melao,cenoura"
  const startCell = "Sheet1!A1";   // Example start cell

  const result1 = fetchDataRavena(groupId, variable, startCell);
  Logger.log(result1);

  const variableSingle = "cidade"; // Example variable that might return "São Paulo"
  const startCellSingle = "Sheet1!B5";

  const result2 = fetchDataRavena(groupId, variableSingle, startCellSingle);
  Logger.log(result2);

  // Example for a variable that might not exist or return null
  const variableNull = "nonexistent";
  const startCellNull = "Sheet1!C10";
  const result3 = fetchDataRavena(groupId, variableNull, startCellNull);
  Logger.log(result3);
}

*/

/**
 * Stores a value in a variable specific to the group.
 * Command: !share <variableName> <data to store>
 * Example: !share frutas Laranja
 */
async function shareVariable(bot, message, args, group) {
	const chatId = message.group ?? message.author;

	try {
		// This command is only available in groups
		if (!message.group) {
			return new ReturnMessage({
				chatId: message.author,
				content: "Este comando só está disponível em grupos."
			});
		}

		const quotedMsg = await message.origin.getQuotedMessage();

		if (args.length < 1 || (args.length < 2 && !quotedMsg)) {
			return new ReturnMessage({
				chatId,
				content:
					'Formato incorreto. Use: `!share <variavel> <dado>`\nExemplo: `!share nomes João`\n\nOu apenas "!share nomes" mas marcando a mensagem com os dados',
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		const variableName = args[0];
		let dataToStore;
		if (!quotedMsg) {
			dataToStore = args.slice(1).join(" ");
		} else {
			dataToStore = quotedMsg.body ?? quotedMsg._data.body;
		}

		// Define the directory and file path for the group's shared data
		const dataShareDir = path.join(database.databasePath, "data-share");
		const filePath = path.join(dataShareDir, `${group.id}.json`);

		// Ensure the data-share directory exists
		await fs.mkdir(dataShareDir, { recursive: true });

		let groupDataShare = {};
		try {
			// Read the existing file if it exists
			const fileContent = await fs.readFile(filePath, "utf8");
			if (fileContent) {
				groupDataShare = JSON.parse(fileContent);
			}
		} catch (error) {
			// If the file doesn't exist (ENOENT), we'll create it.
			// For other errors, we log and notify the user.
			if (error.code !== "ENOENT") {
				logger.error(`Error reading or parsing ${filePath}:`, error);
				return new ReturnMessage({
					chatId,
					content: "Ocorreu um erro ao ler o arquivo de dados. O arquivo pode estar corrompido.",
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				});
			}
		}

		// If the variable (key) doesn't exist, initialize it with an empty array
		if (!groupDataShare[variableName]) {
			groupDataShare[variableName] = [];
		}

		// Add the new data to the variable's array
		groupDataShare[variableName].push(dataToStore);

		// Write the updated data back to the JSON file
		await fs.writeFile(filePath, JSON.stringify(groupDataShare, null, "\t"), "utf8");

		const response = `✅ Dado salvo em '${variableName}'.\nTotal de itens agora: ${groupDataShare[variableName].length}.\n\n> ${process.env.BOT_DOMAIN ?? ""} -> /getData/${group.id}/${variableName}`;

		return new ReturnMessage({
			chatId,
			content: response,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Error in shareVariable:", error);

		return new ReturnMessage({
			chatId,
			content: "Ocorreu um erro inesperado ao compartilhar estes dados.",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}
}

const commands = [
	new Command({
		name: "share",
		description: "Compartilhe dados com a API da ravena",
		category: "arquivos",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "⬆️"
		},
		cooldown: 1,
		method: shareVariable
	})
];

// module.exports = { commands };
