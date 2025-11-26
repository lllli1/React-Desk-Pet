import DeskPet from './deskpet.jsx';

function App() {
  return (
    // 外层容器不需要任何样式，DeskPet 组件已经处理了全屏定位
    <div className="App">
      <DeskPet />
      
      {/* 如果你网页背景是白色的，可能看不清白色的字，可以加个临时背景测试 */}
      <div style={{ 
        position: 'absolute', 
        zIndex: -1, 
        top: 0, 
        left: 0, 
        width: '100%', 
        height: '100%', 
        background: '#f0f2f5' // 浅灰色背景方便看清桌宠
      }}>
        <h1 style={{ textAlign: 'center', marginTop: '50px' }}>React Web 桌宠测试</h1>
      </div>
    </div>
  );
}

export default App;
