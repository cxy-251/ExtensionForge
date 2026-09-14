'use strict';
const {
  Service
}=require("ee-core"),{
  app,dialog,BrowserWindow,session
}=require("electron"),axios=require("axios"),common=require("../common"),path=require("path"),fs=require('fs'),{
  download
}=require("electron-dl"),Services=require("ee-core/services"),Addon=require("ee-core/addon"),{
  value
}=require("lodash/seq");
class CollectionService extends Service{
  constructor(_0x231209){
    super(_0x231209),this.window=null,this.listener={
    };
  }async.setListener(_0x24c851){
    this.listener=_0x24c851;
  }async.open(_0x5c27cc){
    app.commandLine.appendSwitch("--ignore-certificate-errors","true");
    if(!this.window||this.window.isDestroyed())this.window=new BrowserWindow({
      'width':666,'height':800,'title':"DyD",'parent':null,'modal':![],'autoHideMenuBar':!![]
    });
    this.window.webContents.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),this.window['on']("closed",()=>{
      this.window=null;
    }),this.window.webContents['on']("page-title-updated",(_0x23546c,_0xed7133)=>{
      this.window.setTitle("【请勿关闭】作品采集窗口 (如果弹出验证码请手动完成验证否则无法采集作品)");
    });
    if(this.listener.onBeforeSendHeaders)this.window.webContents.session.webRequest.onBeforeSendHeaders(async(_0x446251,_0x3965ff)=>{
      this.listener.onBeforeSendHeaders(this.window,_0x446251),_0x3965ff({
        'cancel':![],'requestHeaders':_0x446251.requestHeaders
      });
    });
    if(this.listener.urlInterceptor)this.window.webContents['on']("will-redirect",(_0x4b3983,_0x26cf88,_0x5412be)=>{
      _0x4b3983.preventDefault(),this.listener.urlInterceptor(_0x26cf88).then(_0x3d40b5=>this.window.loadURL(_0x3d40b5));
    });
    if(this.listener.onDidFinishLoad)this.window.webContents['on']("did-finish-load",()=>{
      this.listener.onDidFinishLoad(this.window);
    });
    this.listener.urlInterceptor?this.listener.urlInterceptor(_0x5c27cc).then(_0x557db3=>this.window.loadURL(_0x557db3)):this.window.loadURL(_0x5c27cc);
  }async.scrollToBottom(_0x1eb7dd){
    try{
      this.window&&!this.window.isDestroyed()&&(this.window.show(),this.window.setSize(666,800),this.window.webContents.executeJavaScript("window.scrollTo(0, document.body.scrollHeight);"));
    }catch(_0x98415b){
    }
  }
}CollectionService.toString=()=>"[class CollectionService]",module.exports=CollectionService;
