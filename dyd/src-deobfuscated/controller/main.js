'use strict';
const {
  Controller
}=require("ee-core"),Log=require("ee-core/log"),Services=require("ee-core/services"),{
  app,dialog,BrowserWindow
}=require("electron"),path=require("path"),axios=require("axios"),fs=require('fs'),{
  download
}=require("electron-dl"),{
  shell
}=require("electron"),common=require("../common"),Addon=require("ee-core/addon");
class MainController extends Controller{
  constructor(_0xb1ddd){
    super(_0xb1ddd);
  }async.winNavHandle(_0x36688c,_0x3fe4f5){
    if(_0x36688c.type===0)this.app.mainWindow.minimize();
    else _0x36688c.type===1&&this.app.mainWindow.close();
  }async.getDefaultSaveDir(_0x497601,_0x1d15ca){
    const _0x41f490=_0x1a7393,_0x59baa4=path.join(process.cwd(),"Downloads");
    if(!fs.existsSync(_0x59baa4))fs.mkdirSync(_0x59baa4);
    return _0x59baa4.toString();
  }async.chooseSaveDir(_0x4b0491,_0x5baf12){
    try{
      const _0x2f4909=await dialog.showOpenDialog({
        'properties':.openDirectory
      });
      return!_0x2f4909.canceled?_0x2f4909.filePaths[0]:'';
    }catch(_0x5836e5){
      return'';
    }
  }async.showPathInFolder(_0x4cb29c,_0x5f4cb3){
    shell.showItemInFolder(_0x4cb29c.path);
  }async.openUrlWithBrowse(_0x552d67,_0x2e61c8){
    shell.openExternal(_0x552d67.url);
  }async.scrollToBottom(_0x2882b6,_0x5b755b){
    Services.get("collection").scrollToBottom({
    });
  }async.openCollectionWindow(_0x550de9,_0x20be32){
    try{
      Services.get(_0x550de9.platform).openCollectionWindow(_0x550de9);
    }catch(_0x458090){
      console.log(_0x458090);
    }
  }async.dispatcherDownload(_0x22dc21,_0x3e1e0b){
    try{
      if(_0x22dc21.dispatchType==="download")switch(_0x22dc21.task.downloadType){
        case "images":Services.get(_0x22dc21.platform).downloadI(_0x22dc21);
        break;
        case "video":Services.get(_0x22dc21.platform).downloadV(_0x22dc21);
        break;
        case "undefined":Services.get(_0x22dc21.platform).downloadU(_0x22dc21);
        break;
      }else _0x22dc21.dispatchType==="interrupt"&&Services.get(_0x22dc21.platform).interruptDownload(_0x22dc21);
    }catch(_0x22d067){
      console.log(_0x22d067);
    }
  }async.testDownload(_0x2dd253,_0x11ddf3){
  }
}MainController.toString=()=>"[class MainController]",module.exports=MainController;
